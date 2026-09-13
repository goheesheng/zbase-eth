/**
 * @zbase-protocol/core — WebSocket UTXO note scanner (Phase 1B)
 *
 * Subscribes to a UTXOPool's `Spent` and `Transferred` events over a WS RPC,
 * trial-decrypts every transferred ciphertext with the user's viewing key,
 * and yields decrypted notes as an async iterable. Wallets and facilitators
 * use this to track balance + spendable notes without polling.
 *
 * Naming: this file is `noteScanner.ts` (NOT `scanner.ts`) because
 * `scanner.ts` is already in use for the chain-agnostic x402-exposure scorer.
 * The two scanners do unrelated things; consolidating later is a separate
 * refactor and would break public API.
 *
 * Transport: we depend ONLY on the WHATWG `WebSocket` global (available in
 * browser, Node ≥22 native, Cloudflare Workers, Bun). No `ethers` or `viem`
 * import is needed for the WS layer — both libraries would force a heavier
 * dependency surface and we already speak JSON-RPC. ABI encoding/decoding of
 * event logs is done by hand for the two specific events we care about. If
 * this proves brittle, the next iteration can swap to viem's `decodeEventLog`
 * (already a root dependency of the consuming Next.js app).
 *
 * Reconnect policy: exponential backoff capped at 30 s. The async iterable
 * yields a `{type:"connected"}` marker on every successful (re)connect so
 * callers can persist the last-seen block and replay if they care about
 * historical correctness across disconnects.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import {
  decryptNoteWithAAD,
  type EncryptedNote,
  type Note,
  type ViewingKeyPair,
} from "./notes.js";

// -----------------------------------------------------------------------------
// Event types
// -----------------------------------------------------------------------------

/** Connection lifecycle marker. Emitted on every (re)connect. */
export interface ScannerConnectedEvent {
  type: "connected";
  reconnectAttempt: number;
  /** Block height to start replaying historical events from, if any. */
  startBlock: bigint;
}

/** A `Spent` log was observed. No ciphertext to decrypt — just nullifier hashes. */
export interface ScannerSpentEvent {
  type: "spent";
  nullifierHash0: bigint;
  nullifierHash1: bigint;
  withdrawnAmount: bigint;
  outputCommitment0: bigint;
  outputCommitment1: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

/** A `Transferred` log was observed AND one ciphertext decrypted for us. */
export interface ScannerTransferredInEvent {
  type: "transferred-in";
  /** Which of the two outputs decrypted (0 or 1). */
  outputIndex: 0 | 1;
  commitment: bigint;
  note: Note;
  /** The other nullifier hash from the same spend — useful for de-duping. */
  siblingNullifierHash: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

/** A `Transferred` log was observed but neither ciphertext was ours. */
export interface ScannerTransferredOtherEvent {
  type: "transferred-other";
  outputCommitment0: bigint;
  outputCommitment1: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

/** Non-fatal error (parse failure, malformed log, etc.) — caller may ignore. */
export interface ScannerErrorEvent {
  type: "error";
  message: string;
  cause?: unknown;
}

export type ScannerEvent =
  | ScannerConnectedEvent
  | ScannerSpentEvent
  | ScannerTransferredInEvent
  | ScannerTransferredOtherEvent
  | ScannerErrorEvent;

// -----------------------------------------------------------------------------
// Topic hashes (keccak256 of canonical event signatures, hex-prefixed)
// -----------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function keccakTopic(signature: string): string {
  return toHex(keccak_256(new TextEncoder().encode(signature)));
}

/**
 * Spent(uint256,uint256,uint256,uint256,uint256)
 * Two indexed nullifier hashes + non-indexed (amount, commitment0, commitment1).
 */
export const SPENT_TOPIC = keccakTopic(
  "Spent(uint256,uint256,uint256,uint256,uint256)",
);

/**
 * Transferred(uint256,uint256,uint256,uint256,(bytes32[4],bytes32,bytes32,bytes32,bytes32),(bytes32[4],bytes32,bytes32,bytes32,bytes32))
 *
 * The two `CommitmentCiphertext` structs are ABI-encoded as tuples. This is
 * the canonical event-signature form Solidity uses for keccak256(topic[0]).
 */
export const TRANSFERRED_TOPIC = keccakTopic(
  "Transferred(uint256,uint256,uint256,uint256,(bytes32[4],bytes32,bytes32,bytes32,bytes32),(bytes32[4],bytes32,bytes32,bytes32,bytes32))",
);

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export interface ScannerOptions {
  /** ws:// or wss:// JSON-RPC endpoint. */
  wsUrl: string;
  /** UTXOPool contract address (0x-prefixed, 20 bytes). */
  utxoPoolAddress: string;
  /** Viewing key to trial-decrypt every Transferred ciphertext against. */
  viewingKey: Pick<ViewingKeyPair, "privateKey">;
  /** Block to start subscription from (default: latest). */
  fromBlock?: bigint;
  /** Custom abort signal to terminate the scanner. */
  signal?: AbortSignal;
  /** Override the reconnect backoff sequence (ms). Default: [1000, 2000, 4000, 8000, 16000, 30000] capped. */
  reconnectBackoffMs?: readonly number[];
  /** Pluggable WebSocket constructor (for tests). Default: globalThis.WebSocket. */
  webSocketCtor?: typeof WebSocket;
}

const DEFAULT_RECONNECT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

// -----------------------------------------------------------------------------
// Log decoding (Phase 1B: hand-decode, swap to viem if maintenance burden grows)
// -----------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex ${hex}`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexToBigint(hex: string): bigint {
  return BigInt(hex);
}

function readWord(bytes: Uint8Array, wordIndex: number): Uint8Array {
  const start = wordIndex * 32;
  if (start + 32 > bytes.length) {
    throw new Error(
      `readWord: out-of-range word ${wordIndex} (bytes length ${bytes.length})`,
    );
  }
  return bytes.slice(start, start + 32);
}

function readWordAsBigint(bytes: Uint8Array, wordIndex: number): bigint {
  const w = readWord(bytes, wordIndex);
  let v = 0n;
  for (const b of w) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Decode the data field of a `Spent` log:
 *   words: [withdrawnAmount, outputCommitment0, outputCommitment1]
 * The two indexed nullifier hashes live in `topics[1..3]`, not in data.
 */
export function decodeSpentLog(log: {
  topics: readonly string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}): Omit<ScannerSpentEvent, "type"> {
  if (log.topics.length < 3) {
    throw new Error("decodeSpentLog: expected 3 topics (signature + 2 indexed)");
  }
  const data = hexToBytes(log.data);
  return {
    nullifierHash0: hexToBigint(log.topics[1]),
    nullifierHash1: hexToBigint(log.topics[2]),
    withdrawnAmount: readWordAsBigint(data, 0),
    outputCommitment0: readWordAsBigint(data, 1),
    outputCommitment1: readWordAsBigint(data, 2),
    blockNumber: hexToBigint(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: Number(hexToBigint(log.logIndex)),
  };
}

/**
 * Decode a Transferred log into raw fields + the two ciphertext blobs ready
 * for trial decryption.
 *
 * Layout (non-indexed args, packed as one ABI-encoded tuple):
 *
 *   word 0   outputCommitment0
 *   word 1   outputCommitment1
 *   word 2   ciphertext0.ciphertext[0]
 *   word 3   ciphertext0.ciphertext[1]
 *   word 4   ciphertext0.ciphertext[2]
 *   word 5   ciphertext0.ciphertext[3]
 *   word 6   ciphertext0.blindedSenderViewingKey
 *   word 7   ciphertext0.blindedReceiverViewingKey
 *   word 8   ciphertext0.memo
 *   word 9   ciphertext0.aad
 *   word 10  ciphertext1.ciphertext[0]
 *   ...
 *   word 17  ciphertext1.aad
 *
 * The 8-word `CommitmentCiphertext` struct is encoded inline (no offset
 * indirection) because every field is a fixed-size value type — Solidity
 * inlines such tuples.
 *
 * The ciphertext blob we feed to `decryptNoteWithAAD` is the concatenation
 * of bytes32[4] (the four word ciphertext slots). See UTXOPool.sol comment
 * on `CommitmentCiphertext` for the per-word convention.
 */
export interface DecodedTransferredLog {
  nullifierHash0: bigint;
  nullifierHash1: bigint;
  outputCommitment0: bigint;
  outputCommitment1: bigint;
  ciphertext0Blob: Uint8Array; // 128 bytes (4 * 32)
  ciphertext0Aad: Uint8Array; //  32 bytes
  ciphertext1Blob: Uint8Array;
  ciphertext1Aad: Uint8Array;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export function decodeTransferredLog(log: {
  topics: readonly string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}): DecodedTransferredLog {
  if (log.topics.length < 3) {
    throw new Error(
      "decodeTransferredLog: expected 3 topics (signature + 2 indexed)",
    );
  }
  const data = hexToBytes(log.data);

  const outputCommitment0 = readWordAsBigint(data, 0);
  const outputCommitment1 = readWordAsBigint(data, 1);

  // ciphertext0 occupies words 2..9, ciphertext1 occupies 10..17.
  const ct0Blob = new Uint8Array(128);
  for (let i = 0; i < 4; i++) ct0Blob.set(readWord(data, 2 + i), i * 32);
  const ct0Aad = readWord(data, 9);

  const ct1Blob = new Uint8Array(128);
  for (let i = 0; i < 4; i++) ct1Blob.set(readWord(data, 10 + i), i * 32);
  const ct1Aad = readWord(data, 17);

  return {
    nullifierHash0: hexToBigint(log.topics[1]),
    nullifierHash1: hexToBigint(log.topics[2]),
    outputCommitment0,
    outputCommitment1,
    ciphertext0Blob: ct0Blob,
    ciphertext0Aad: ct0Aad,
    ciphertext1Blob: ct1Blob,
    ciphertext1Aad: ct1Aad,
    blockNumber: hexToBigint(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: Number(hexToBigint(log.logIndex)),
  };
}

/**
 * Trial-decrypt both ciphertexts of a Transferred log against the viewing
 * key. Returns the matching event or `null` if neither ciphertext belongs to
 * this wallet.
 *
 * The encrypted blob fed to `decryptNoteWithAAD` is the on-chain wire format
 * that `encryptNoteForTransfer` produces — see notes.ts `EncryptedNote`
 * layout. The contract stores it spread across four bytes32 words; we
 * reassemble it back into the linear byte buffer here.
 *
 * Phase 1B caveat: the v0 `encryptNote` envelope (ephPub|viewTag|nonce|ct)
 * does not yet fit neatly inside bytes32[4]. A follow-up will define a
 * compact wire layout; the v0 wire is the linear blob and that's what we
 * decode here. The hand-decoder above is a placeholder that will need to
 * track that schema once it's frozen.
 */
export function tryDecryptTransferred(
  decoded: DecodedTransferredLog,
  viewingPrivateKey: Uint8Array,
): ScannerTransferredInEvent | ScannerTransferredOtherEvent {
  // Try output 0
  const note0 = decryptNoteWithAAD(
    decoded.ciphertext0Blob,
    viewingPrivateKey,
    decoded.outputCommitment0,
  );
  if (note0) {
    return {
      type: "transferred-in",
      outputIndex: 0,
      commitment: decoded.outputCommitment0,
      note: note0,
      siblingNullifierHash: decoded.nullifierHash1,
      blockNumber: decoded.blockNumber,
      txHash: decoded.txHash,
      logIndex: decoded.logIndex,
    };
  }
  // Try output 1
  const note1 = decryptNoteWithAAD(
    decoded.ciphertext1Blob,
    viewingPrivateKey,
    decoded.outputCommitment1,
  );
  if (note1) {
    return {
      type: "transferred-in",
      outputIndex: 1,
      commitment: decoded.outputCommitment1,
      note: note1,
      siblingNullifierHash: decoded.nullifierHash0,
      blockNumber: decoded.blockNumber,
      txHash: decoded.txHash,
      logIndex: decoded.logIndex,
    };
  }
  return {
    type: "transferred-other",
    outputCommitment0: decoded.outputCommitment0,
    outputCommitment1: decoded.outputCommitment1,
    blockNumber: decoded.blockNumber,
    txHash: decoded.txHash,
    logIndex: decoded.logIndex,
  };
}

// -----------------------------------------------------------------------------
// WebSocket subscription core
// -----------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: { subscription: string; result: unknown };
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Create an async iterable scanner over a UTXOPool's events.
 *
 * Usage:
 * ```ts
 * for await (const ev of createScanner({ wsUrl, utxoPoolAddress, viewingKey })) {
 *   if (ev.type === "transferred-in") {
 *     wallet.addNote(ev.commitment, ev.note);
 *   } else if (ev.type === "spent") {
 *     wallet.markSpent(ev.nullifierHash0, ev.nullifierHash1);
 *   }
 * }
 * ```
 *
 * Cancellation: pass `signal: AbortSignal` (or break out of the for-await).
 * On abort, the underlying WebSocket is closed cleanly.
 */
export async function* createScanner(
  options: ScannerOptions,
): AsyncIterable<ScannerEvent> {
  const backoff =
    options.reconnectBackoffMs && options.reconnectBackoffMs.length > 0
      ? options.reconnectBackoffMs
      : DEFAULT_RECONNECT_BACKOFF_MS;
  const WsCtor = options.webSocketCtor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WsCtor) {
    throw new Error(
      "createScanner: WebSocket constructor not available; pass options.webSocketCtor explicitly",
    );
  }

  let reconnectAttempt = 0;
  let lastSeenBlock = options.fromBlock ?? 0n;

  outer: while (!options.signal?.aborted) {
    let ws: WebSocket;
    try {
      ws = new WsCtor(options.wsUrl);
    } catch (err) {
      yield { type: "error", message: "websocket-open-failed", cause: err };
      const wait = backoff[Math.min(reconnectAttempt, backoff.length - 1)];
      reconnectAttempt++;
      await sleep(wait, options.signal);
      continue;
    }

    const queue = new EventQueue();
    let subscriptionId: string | null = null;
    let nextRpcId = 1;

    const onOpen = () => {
      const subscribe: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: nextRpcId++,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: options.utxoPoolAddress,
            topics: [[SPENT_TOPIC, TRANSFERRED_TOPIC]],
          },
        ],
      };
      ws.send(JSON.stringify(subscribe));
    };

    const onMessage = (raw: { data: unknown }) => {
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(String(raw.data)) as JsonRpcResponse;
      } catch (err) {
        queue.push({
          type: "error",
          message: "rpc-parse-failed",
          cause: err,
        });
        return;
      }
      if (parsed.error) {
        queue.push({
          type: "error",
          message: `rpc-error: ${parsed.error.message}`,
        });
        return;
      }
      if (parsed.result && typeof parsed.result === "string" && subscriptionId === null) {
        subscriptionId = parsed.result;
        queue.push({ type: "connected", reconnectAttempt, startBlock: lastSeenBlock });
        return;
      }
      if (parsed.method === "eth_subscription" && parsed.params) {
        const log = parsed.params.result as {
          topics: string[];
          data: string;
          blockNumber: string;
          transactionHash: string;
          logIndex: string;
          removed?: boolean;
        };
        if (log.removed) return;
        try {
          const topic0 = log.topics[0]?.toLowerCase();
          if (topic0 === SPENT_TOPIC.toLowerCase()) {
            const ev = decodeSpentLog(log);
            lastSeenBlock = ev.blockNumber;
            queue.push({ type: "spent", ...ev });
          } else if (topic0 === TRANSFERRED_TOPIC.toLowerCase()) {
            const decoded = decodeTransferredLog(log);
            lastSeenBlock = decoded.blockNumber;
            queue.push(tryDecryptTransferred(decoded, options.viewingKey.privateKey));
          }
        } catch (err) {
          queue.push({
            type: "error",
            message: "log-decode-failed",
            cause: err,
          });
        }
      }
    };

    const onClose = () => {
      queue.close();
    };
    const onError = (err: unknown) => {
      queue.push({ type: "error", message: "websocket-error", cause: err });
      queue.close();
    };

    ws.addEventListener("open", onOpen as () => void);
    ws.addEventListener("message", onMessage as (ev: MessageEvent) => void);
    ws.addEventListener("close", onClose as () => void);
    ws.addEventListener("error", onError as (ev: Event) => void);

    const abortListener = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      queue.close();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });

    try {
      for await (const ev of queue) {
        yield ev;
      }
    } finally {
      options.signal?.removeEventListener("abort", abortListener);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }

    if (options.signal?.aborted) break outer;

    const wait = backoff[Math.min(reconnectAttempt, backoff.length - 1)];
    reconnectAttempt++;
    await sleep(wait, options.signal);
  }
}

// -----------------------------------------------------------------------------
// Pure helpers used by both the live scanner and the unit tests
// -----------------------------------------------------------------------------

/**
 * In-memory equivalent of the live scanner: feed it an array of already-decoded
 * Transferred logs and the user's viewing key, get back exactly the events
 * the live scanner would have yielded. Used by tests and by historical replay
 * callers that have already fetched logs via `eth_getLogs`.
 */
export function scanTransferredLogs(
  logs: readonly DecodedTransferredLog[],
  viewingPrivateKey: Uint8Array,
): Array<ScannerTransferredInEvent | ScannerTransferredOtherEvent> {
  return logs.map((log) => tryDecryptTransferred(log, viewingPrivateKey));
}

// -----------------------------------------------------------------------------
// Internal: bounded async queue used to bridge WS callbacks → async iterator
// -----------------------------------------------------------------------------

class EventQueue implements AsyncIterable<ScannerEvent> {
  private buffer: ScannerEvent[] = [];
  private waiters: Array<(v: IteratorResult<ScannerEvent>) => void> = [];
  private closed = false;

  push(event: ScannerEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: undefined as unknown as ScannerEvent, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ScannerEvent> {
    const self = this;
    return {
      next(): Promise<IteratorResult<ScannerEvent>> {
        const buffered = self.buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (self.closed) {
          return Promise.resolve({
            value: undefined as unknown as ScannerEvent,
            done: true,
          });
        }
        return new Promise<IteratorResult<ScannerEvent>>((resolve) => {
          self.waiters.push(resolve);
        });
      },
      return(): Promise<IteratorResult<ScannerEvent>> {
        self.close();
        return Promise.resolve({
          value: undefined as unknown as ScannerEvent,
          done: true,
        });
      },
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// -----------------------------------------------------------------------------
// Re-exports for ergonomics — callers can import everything from noteScanner.
// -----------------------------------------------------------------------------

export type { EncryptedNote, Note, ViewingKeyPair } from "./notes.js";
