"use client";

/**
 * DepositWithdraw
 * ───────────────
 * Test the full deposit + withdraw flow from the connected wallet against the
 * production stack on Base Sepolia (real Sepolia USDC). Each form action is
 * mirrored as a CodeSample below it so an agent dev can copy-paste the same
 * call into their stack.
 *
 * Flow:
 *   1. Approve USDC if allowance < amount.
 *   2. deposit(asset, amount, precommitment) — store the secrets in the
 *      encrypted deposit vault so the user can withdraw later.
 *   3. POST /api/deposits/confirm with the confirmed tx hash (the server
 *      refreshes the ASP root without exposing its credential to the browser).
 *   4. POST /api/withdraw — server generates proof + relays settle tx.
 *
 * The deposits-by-this-wallet panel shares the encrypted deposit vault with
 * the canonical `/app` page (src/lib/deposit-vault.ts), which also dual-reads
 * the legacy `zbase-deposits-*` / `zx402-deposits-*` localStorage keys until
 * an unlock migrates them. Deposits made here show up there and vice-versa.
 */

import { useState, useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract, useSendTransaction } from "wagmi";
import { parseUnits, formatUnits, parseAbi } from "viem";
// Browser-safe shim — full @zbase-protocol/core barrel pulls snarkjs (node:module)
// which the client bundler can't ingest. /app/page.tsx uses the same import.
import { generateDepositSecrets } from "@/lib/privacy";
import { useDepositVault, ensureNoteSeed, nextDepositIndex } from "@/lib/deposit-vault";
import { deriveForwardingNote } from "@zbase-protocol/core/wallet";
import { confirmDepositForAsp } from "@/lib/asp-confirm-client";
import CodeSample from "./CodeSample";

interface StoredDeposit {
  nullifier: string;
  secret: string;
  precommitment: string;
  /**
   * HD derivation index, when this note came from the vault seed. Present ⇒ the note
   * is re-derivable and nextDepositIndex() will not reuse the slot. Absent ⇒ a legacy
   * random note: the secrets above are the ONLY copy of that money.
   */
  index?: number;
  value: string;
  label?: string;
  commitment?: string;
  txHash: string;
  amountHuman: string;
  asset: string;
  status: "pending" | "indexed" | "spent";
  createdAt: number;
}

interface StackInfo {
  // Always "production" post-staging-abandonment 2026-06-01 (see
  // src/lib/contracts.ts header). The field is retained on the interface for
  // future flexibility but the staging branch has been removed.
  label: "production";
  entrypoint: string;
  usdcPool: string;
  usdc: string;
}

interface Props {
  stack: StackInfo | null;
}

const USDC_ABI = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const DEPOSIT_ABI = parseAbi([
  "function deposit(address _asset, uint256 _amount, uint256 _precommitment)",
]);

// keccak256("Deposited(address,uint256,uint256,uint256,uint256)") — matches
// the canonical reference in scripts/seed-pools.ts and src/app/api/demo/run.
const DEPOSITED_TOPIC =
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";

// Phase 1C: deposit persistence goes through the encrypted vault module
// (src/lib/deposit-vault.ts). It still dual-reads the legacy zbase-/zx402-
// localStorage keys (both address-case forms) until an unlock migrates them
// to the server-side ciphertext vault — without that shim, users who
// deposited via /test before the rename would lose their nullifier+secret
// and funds would become unwithdrawable on-chain.

function fmtAmt(atomic: string | bigint, decimals = 6): string {
  const n = typeof atomic === "string" ? BigInt(atomic) : atomic;
  return Number(formatUnits(n, decimals)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type DepositStatus =
  | "idle"
  | "approving"
  | "depositing"
  | "confirming"
  | "indexing"
  | "done"
  | "error";

type WithdrawStatus =
  | "idle"
  | "proving"
  | "submitting"
  | "done"
  | "error";

export default function DepositWithdraw({ stack }: Props) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  // ── Deposit form state ───────────────────────────────────────────────
  const [depositAmount, setDepositAmount] = useState("1");
  const [depositStatus, setDepositStatus] = useState<DepositStatus>("idle");
  const [depositTxHash, setDepositTxHash] = useState("");
  const [depositError, setDepositError] = useState("");

  // ── Withdraw form state ──────────────────────────────────────────────
  const [selectedDepositIdx, setSelectedDepositIdx] = useState<number>(-1);
  const [withdrawRecipient, setWithdrawRecipient] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawStatus, setWithdrawStatus] = useState<WithdrawStatus>("idle");
  const [withdrawTxHash, setWithdrawTxHash] = useState("");
  const [withdrawError, setWithdrawError] = useState("");

  // ── Deposits (encrypted vault; localStorage fallback while locked) ───
  const {
    deposits,
    status: vaultStatus,
    error: vaultError,
    unlock: unlockDepositVault,
    save: saveDepositVault,
  } = useDepositVault<StoredDeposit>(address);

  const usdcAddress = stack?.usdc as `0x${string}` | undefined;
  const entrypointAddress = stack?.entrypoint as `0x${string}` | undefined;
  const poolAddress = stack?.usdcPool as `0x${string}` | undefined;

  // ── Deposit handler ──────────────────────────────────────────────────
  const handleDeposit = useCallback(async () => {
    if (
      !address ||
      !publicClient ||
      !usdcAddress ||
      !entrypointAddress ||
      !poolAddress
    )
      return;
    setDepositStatus("approving");
    setDepositError("");
    setDepositTxHash("");

    try {
      const amountAtomic = parseUnits(depositAmount, 6);

      // 1. Approve if needed.
      const allowance = (await publicClient.readContract({
        address: usdcAddress,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [address, entrypointAddress],
      })) as bigint;

      if (allowance < amountAtomic) {
        const approveTx = await writeContractAsync({
          address: usdcAddress,
          abi: USDC_ABI,
          functionName: "approve",
          args: [entrypointAddress, 2n ** 256n - 1n],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      // 2. Deposit secrets + precommitment. PREFER seed-derived (mirrors /app):
      //    a note's nullifier/secret ARE the money and are issued once, so a random
      //    note that outlives its backup is gone forever (0.985 USDC, 2026-07-16).
      //    Derived from the vault's BIP39 seed, a wiped device rebuilds every note
      //    from a chain scan.
      //
      //    Falls back to random when there is no seed — locked vault, un-migrated v1
      //    vault, or an ERC-1271 wallet that never unlocks (vault-messages.ts:19-24).
      //    Random is the status quo, not a regression; depositing against a seed we
      //    could not durably persist would be strictly worse.
      //
      //    Index comes from max(stored index)+1, never array length: the vault is a
      //    union merge that can shrink, and a fresh install would restart at 0 →
      //    duplicate commitment → unspendable deposit.
      //
      //    `label` is a placeholder either way — the real on-chain label is parsed
      //    from the Deposited event below and overwrites it.
      const seed = await ensureNoteSeed(address);
      const derivedIndex = seed ? nextDepositIndex(address) : -1;
      const derived = seed ? deriveForwardingNote(seed, derivedIndex) : null;
      const secrets = derived
        ? {
            nullifier: BigInt(derived.nullifier),
            secret: BigInt(derived.secret),
            precommitment: BigInt(derived.precommitment),
          }
        : generateDepositSecrets(amountAtomic, 0n);

      // 3. deposit() — needs explicit gas per CLAUDE.md gotcha.
      setDepositStatus("depositing");
      const depositTx = await writeContractAsync({
        address: entrypointAddress,
        abi: DEPOSIT_ABI,
        functionName: "deposit",
        args: [usdcAddress, amountAtomic, secrets.precommitment],
        gas: 1_000_000n,
      });
      setDepositTxHash(depositTx);
      setDepositStatus("confirming");

      // 4. Wait for receipt + parse Deposited event.
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: depositTx,
      });

      let onChainCommitment = "0";
      let onChainLabel = "0";
      let onChainValue = "0";
      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() === poolAddress.toLowerCase() &&
          log.topics[0] === DEPOSITED_TOPIC
        ) {
          const data = log.data;
          if (data.length >= 258) {
            onChainCommitment = BigInt("0x" + data.slice(2, 66)).toString();
            onChainLabel = BigInt("0x" + data.slice(66, 130)).toString();
            onChainValue = BigInt("0x" + data.slice(130, 194)).toString();
          }
          break;
        }
      }

      // 5. Persist deposit + trigger ASP update (so it's immediately spendable).
      //    All bigints serialized to base-10 strings for localStorage round-trip.
      const stored: StoredDeposit = {
        nullifier: secrets.nullifier.toString(),
        secret: secrets.secret.toString(),
        precommitment: secrets.precommitment.toString(),
        value: onChainValue,
        label: onChainLabel,
        commitment: onChainCommitment,
        txHash: depositTx,
        amountHuman: depositAmount,
        asset: usdcAddress,
        status: "pending",
        createdAt: Date.now(),
        // Derived notes only. Stamping a random note would burn a slot the seed still
        // owns, and the seed would later derive into it — a duplicate commitment.
        ...(derived ? { index: derivedIndex } : {}),
      };
      saveDepositVault((prev) => [stored, ...prev]);

      setDepositStatus("indexing");
      const asp = await confirmDepositForAsp(depositTx);
      if (asp.status === "rejected") {
        throw new Error(
          "Deposit was rejected by association policy and cannot withdraw privately.",
        );
      }

      saveDepositVault((prev) =>
        prev.map((d) =>
          d.txHash === depositTx ? { ...d, status: "indexed" as const } : d,
        ),
      );

      setDepositStatus("done");
    } catch (err) {
      const msg = (err as Error).message || "Deposit failed";
      setDepositError(msg.split("\n")[0].slice(0, 240));
      setDepositStatus("error");
    }
  }, [
    address,
    publicClient,
    usdcAddress,
    entrypointAddress,
    poolAddress,
    writeContractAsync,
    depositAmount,
    saveDepositVault,
  ]);

  // ── Withdraw handler ─────────────────────────────────────────────────
  const handleWithdraw = useCallback(async () => {
    if (!address) return;
    const deposit = deposits[selectedDepositIdx];
    if (!deposit) {
      setWithdrawError("Select a deposit to withdraw from.");
      setWithdrawStatus("error");
      return;
    }
    if (
      !withdrawRecipient.match(/^0x[a-fA-F0-9]{40}$/) &&
      withdrawRecipient.length > 0
    ) {
      setWithdrawError("Recipient must be a 0x… address (or leave blank to use connected wallet).");
      setWithdrawStatus("error");
      return;
    }
    const recipient = withdrawRecipient || address;
    setWithdrawStatus("proving");
    setWithdrawError("");
    setWithdrawTxHash("");

    try {
      const body: Record<string, string> = {
        nullifier: deposit.nullifier,
        secret: deposit.secret,
        value: deposit.value,
        label: deposit.label || "0",
        commitment: deposit.commitment || "0",
        recipient,
      };
      // Partial withdraw if user typed an amount less than full value.
      if (withdrawAmount && withdrawAmount.trim().length > 0) {
        const atomic = parseUnits(withdrawAmount, 6);
        body.amountAtomic = atomic.toString();
      }

      setWithdrawStatus("submitting");
      const res = await fetch("/api/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!data.success || !data.txHash) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setWithdrawTxHash(data.txHash);

      // Mark spent (or partially spent — for now, full spend).
      saveDepositVault((prev) =>
        prev.map((d, i) =>
          i === selectedDepositIdx ? { ...d, status: "spent" as const } : d,
        ),
      );

      setWithdrawStatus("done");
    } catch (err) {
      const msg = (err as Error).message || "Withdraw failed";
      setWithdrawError(msg.split("\n")[0].slice(0, 240));
      setWithdrawStatus("error");
    }
  }, [
    address,
    deposits,
    selectedDepositIdx,
    withdrawRecipient,
    withdrawAmount,
    saveDepositVault,
  ]);

  // ── Ragequit handler (PUBLIC self-exit) ──────────────────────────────────
  // Opt-in escape hatch: reclaim your OWN deposit directly, bypassing the ASP.
  // NOT private — the payout goes to the original depositor's wallet, revealing
  // the deposit↔depositor link. The pool's ragequit() requires msg.sender ==
  // original depositor, so this MUST be signed by the connected (depositor)
  // wallet — the server only builds the proof/calldata; it cannot relay it.
  const handleRagequit = useCallback(async () => {
    if (!address) return;
    const deposit = deposits[selectedDepositIdx];
    if (!deposit) {
      setWithdrawError("Select a deposit to reclaim.");
      setWithdrawStatus("error");
      return;
    }
    if (
      !window.confirm(
        "PUBLIC reclaim (ragequit): this returns your deposit to THIS wallet and " +
          "reveals the deposit↔wallet link on-chain — it is NOT private. Use this only " +
          "if a normal (private) withdraw isn't available. Continue?",
      )
    ) {
      return;
    }
    setWithdrawStatus("proving");
    setWithdrawError("");
    setWithdrawTxHash("");

    try {
      // 1. Server builds the ragequit proof + calldata.
      const res = await fetch("/api/ragequit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nullifier: deposit.nullifier,
          secret: deposit.secret,
          value: deposit.value,
          label: deposit.label || "0",
          depositor: address,
        }),
      });
      const data = await res.json();
      if (!data.ragequit || !data.to || !data.data) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // 2. Submit the pre-encoded calldata from the connected (depositor) wallet
      //    as a raw tx — CANNOT be relayed (contract enforces OnlyOriginalDepositor).
      setWithdrawStatus("submitting");
      const txHash = await sendTransactionAsync({
        to: data.to as `0x${string}`,
        data: data.data as `0x${string}`,
      });

      setWithdrawTxHash(txHash as string);
      saveDepositVault((prev) =>
        prev.map((d, i) =>
          i === selectedDepositIdx ? { ...d, status: "spent" as const } : d,
        ),
      );
      setWithdrawStatus("done");
    } catch (err) {
      const msg = (err as Error).message || "Ragequit failed";
      setWithdrawError(msg.split("\n")[0].slice(0, 240));
      setWithdrawStatus("error");
    }
  }, [address, deposits, selectedDepositIdx, saveDepositVault, sendTransactionAsync]);

  // ── Render ────────────────────────────────────────────────────────────
  if (!stack) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-transparent p-8 text-[13px] text-gray-500">
        Waiting for stack info…
      </div>
    );
  }

  const symbol = "USDC";
  const isBusy =
    depositStatus === "approving" ||
    depositStatus === "depositing" ||
    depositStatus === "confirming" ||
    depositStatus === "indexing";

  return (
    <div className="flex flex-col gap-10">
      {/* ── DEPOSIT block ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-200 bg-white p-8">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Deposit
            </div>
            <h3
              className="mt-2 text-[24px] leading-[1.1] tracking-[-0.3px] text-black"
              style={{
                fontFamily: "var(--font-fraunces), 'Fraunces', serif",
                fontWeight: 400,
              }}
            >
              Add USDC to the private pool
            </h3>
          </div>
          <span className="font-mono text-[11px] text-gray-500">
            min 1.00 {symbol}
          </span>
        </div>

        <div className="mt-6 flex flex-wrap items-end gap-4">
          <label className="flex-1 min-w-[200px]">
            <span className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Amount
            </span>
            <div className="mt-1 flex items-center rounded-md border border-gray-300 bg-white">
              <input
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                inputMode="decimal"
                className="w-full bg-transparent px-4 py-3 font-mono text-[18px] tabular-nums text-black outline-none"
                placeholder="1.00"
              />
              <span className="px-4 font-inter text-[12px] text-gray-500">
                {symbol}
              </span>
            </div>
          </label>
          <button
            onClick={handleDeposit}
            disabled={!isConnected || isBusy}
            className="rounded-md bg-indigo-600 px-5 py-3 font-syne text-[12px] uppercase tracking-[0.14em] text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {!isConnected
              ? "Connect wallet"
              : depositStatus === "approving"
              ? "Approving USDC…"
              : depositStatus === "depositing"
              ? "Confirm in wallet…"
              : depositStatus === "confirming"
              ? "Awaiting confirmation…"
              : depositStatus === "indexing"
              ? "Updating ASP root…"
              : depositStatus === "done"
              ? "Deposit again"
              : "Deposit"}
          </button>
        </div>

        {depositStatus === "error" && (
          <div className="mt-4 rounded-md border border-[#deb6a8] bg-[#f0d6cf] px-3 py-2 font-inter text-[12px] text-[#6b2e1f]">
            {depositError}
          </div>
        )}
        {depositTxHash && (
          <div className="mt-4 flex items-center gap-3 font-mono text-[12px] text-gray-600">
            <span className="font-syne text-[10px] uppercase tracking-[0.14em] text-gray-500">
              deposit tx
            </span>
            <a
              href={`https://sepolia.basescan.org/tx/${depositTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-black"
            >
              {depositTxHash.slice(0, 10)}…{depositTxHash.slice(-8)}
            </a>
          </div>
        )}
      </div>

      {/* ── Deposit code sample ── */}
      <CodeSample
        caption="Deposit equivalent"
        samples={{
          curl: `# Approve once (USDC is ERC20)
cast send ${usdcAddress} \\
  'approve(address,uint256)' \\
  ${entrypointAddress} \\
  $(cast max-uint) \\
  --private-key $YOUR_PRIVATE_KEY \\
  --rpc-url https://sepolia.base.org

# Then deposit
cast send ${entrypointAddress} \\
  'deposit(address,uint256,uint256)' \\
  ${usdcAddress} \\
  ${parseUnits(depositAmount || "1", 6).toString()} \\
  <precommitment_uint256> \\
  --gas-limit 1000000 \\
  --private-key $YOUR_PRIVATE_KEY \\
  --rpc-url https://sepolia.base.org

# Precommitment = Poseidon(2)([nullifier, secret])
# Use @zbase-protocol/core's computePrecommitment() — see TS tab.`,
          typescript: `import { generateNewMnemonic, deriveForwardingNote } from "@zbase-protocol/core/wallet";
import { parseUnits, parseAbi } from "viem";

// DERIVE the note from a seed — do not generate random secrets.
//
// A note's nullifier/secret ARE the money and the pool hands them to you exactly
// once. Lose them and the USDC is locked in the pool forever: no ragequit, no
// recovery, no support ticket. Derived from a seed, a wiped machine rebuilds every
// note by scanning the chain (recoverForwardingNotes) — the secrets stop being
// losable. Back up the seed ONCE, offline; never the individual notes.
const seed = generateNewMnemonic();     // 12 words. THIS is what you back up.
const note = deriveForwardingNote(seed, 0);   // index 0, 1, 2, … per deposit

// 1. Approve
await client.writeContract({
  address: "${usdcAddress}",
  abi: parseAbi(["function approve(address,uint256)"]),
  functionName: "approve",
  args: ["${entrypointAddress}", 2n ** 256n - 1n],
});

// 2. Deposit at the DERIVED precommitment
const depositTx = await client.writeContract({
  address: "${entrypointAddress}",
  abi: parseAbi(["function deposit(address,uint256,uint256)"]),
  functionName: "deposit",
  args: [
    "${usdcAddress}",
    parseUnits("${depositAmount || "1"}", 6),
    BigInt(note.precommitment),
  ],
  gas: 1_000_000n,
});

// 3. Nothing to persist but the seed. Rebuild the balance any time:
//      getWalletBalance({ mnemonic: seed, depositedEvents, isSpent })
//    (Deposits recover from the seed. Change notes still need their value from the
//     payment response — see the SDK docs.)

// 4. Confirm the tx; zBase refreshes ASP server-side without exposing its secret
const aspRes = await fetch("https://zbase.app/api/deposits/confirm", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ txHash: depositTx }),
});
if (!aspRes.ok) throw new Error(await aspRes.text());`,
          python: `from zbase_core import generate_deposit_secrets, compute_precommitment
# Note: Python SDK is illustrative. The reference implementation lives in
# @zbase-protocol/core (TypeScript); a Python port is on the roadmap.

secrets = generate_deposit_secrets()
precommitment = compute_precommitment(secrets["nullifier"], secrets["secret"])

# 1. Approve
usdc.functions.approve(
    "${entrypointAddress}",
    2**256 - 1,
).transact()

# 2. Deposit
deposit_tx = entrypoint.functions.deposit(
    "${usdcAddress}",
    ${parseUnits(depositAmount || "1", 6).toString()},
    int(precommitment),
).transact({"gas": 1_000_000})

# 3. Confirm the deposit; zBase performs the privileged ASP refresh server-side
asp = requests.post(
    "https://zbase.app/api/deposits/confirm",
    json={"txHash": deposit_tx.hex()},
)
asp.raise_for_status()`,
        }}
      />

      {/* ── DEPOSITS list ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-200 bg-white p-8">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Your deposits ({deposits.length})
            </div>
            <h3
              className="mt-2 text-[20px] leading-[1.1] tracking-[-0.3px] text-black"
              style={{
                fontFamily: "var(--font-fraunces), 'Fraunces', serif",
                fontWeight: 400,
              }}
            >
              {vaultStatus === "unlocked"
                ? "Stored in your encrypted vault"
                : "Stored locally in this browser"}
            </h3>
          </div>
          <div className="flex items-center gap-4">
            {isConnected && vaultStatus !== "unlocked" && (
              <button
                onClick={() => unlockDepositVault()}
                disabled={vaultStatus === "unlocking"}
                className="font-syne text-[10px] uppercase tracking-[0.14em] text-indigo-500 hover:text-indigo-700 disabled:opacity-50"
                title="Encrypt your deposit secrets under a wallet-signature-derived key and store them server-side as ciphertext — recoverable from any browser."
              >
                {vaultStatus === "unlocking" ? "Unlocking…" : "Unlock vault"}
              </button>
            )}
            {deposits.length > 0 && (
              <button
                onClick={() => {
                  if (
                    address &&
                    confirm(
                      "Clear all deposit records for this address? You will lose the ability to withdraw any pending deposits.",
                    )
                  ) {
                    saveDepositVault([]);
                    setSelectedDepositIdx(-1);
                  }
                }}
                className="font-syne text-[10px] uppercase tracking-[0.14em] text-gray-400 hover:text-[#6b2e1f]"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
        {vaultError && (
          <p className="mt-3 font-inter text-[11px] text-red-600">{vaultError}</p>
        )}

        {deposits.length === 0 ? (
          <div className="mt-6 rounded-md border border-dashed border-gray-300 p-6 text-center font-inter text-[12px] text-gray-400">
            No deposits yet. Make one above to enable withdrawals.
          </div>
        ) : (
          <ul className="mt-6 divide-y divide-gray-100">
            {deposits.map((d, i) => {
              const isSelected = i === selectedDepositIdx;
              const tone =
                d.status === "spent"
                  ? "bg-[#efece4] text-[#3a342a] border-[#dcd6c5]"
                  : d.status === "indexed"
                  ? "bg-[#e8eee0] text-[#3d4a2c] border-[#cfdbbf]"
                  : "bg-[#f3e7c8] text-[#6b5417] border-[#e2d09a]";
              return (
                <li key={d.txHash + i} className="py-3">
                  <button
                    onClick={() =>
                      setSelectedDepositIdx(isSelected ? -1 : i)
                    }
                    disabled={d.status === "spent"}
                    className={`flex w-full items-center gap-4 rounded-md px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? "bg-[#e0e3f6]"
                        : "hover:bg-[#f8f7f4] disabled:opacity-40 disabled:hover:bg-transparent"
                    }`}
                  >
                    <div className="flex-1">
                      <div className="font-mono text-[14px] text-black tabular-nums">
                        {fmtAmt(d.value || "0")}{" "}
                        <span className="text-[11px] font-normal text-gray-500">
                          {symbol}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-gray-500">
                        <a
                          href={`https://sepolia.basescan.org/tx/${d.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="underline hover:text-gray-700"
                        >
                          {d.txHash.slice(0, 10)}…{d.txHash.slice(-8)}
                        </a>
                        <span className="ml-3">
                          {new Date(d.createdAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-[3px] font-inter text-[10px] font-medium tracking-wide ${tone}`}
                    >
                      {d.status}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── WITHDRAW block ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-200 bg-white p-8">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Withdraw
            </div>
            <h3
              className="mt-2 text-[24px] leading-[1.1] tracking-[-0.3px] text-black"
              style={{
                fontFamily: "var(--font-fraunces), 'Fraunces', serif",
                fontWeight: 400,
              }}
            >
              Settle to any address — privately
            </h3>
            <p className="mt-2 max-w-[520px] font-inter text-[13px] text-gray-500">
              The pool pays the recipient. Your wallet is not in the relay tx.
              Pick a deposit above, set the recipient, sign nothing — the
              postman relays for you.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <label>
            <span className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Recipient (blank = your wallet)
            </span>
            <input
              value={withdrawRecipient}
              onChange={(e) => setWithdrawRecipient(e.target.value)}
              placeholder={address ?? "0x…"}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-4 py-3 font-mono text-[13px] text-black outline-none placeholder:text-gray-400"
            />
          </label>
          <label>
            <span className="font-syne text-[10px] uppercase tracking-[0.16em] text-gray-500">
              Amount (blank = full deposit)
            </span>
            <div className="mt-1 flex items-center rounded-md border border-gray-300 bg-white">
              <input
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                inputMode="decimal"
                placeholder={
                  selectedDepositIdx >= 0
                    ? fmtAmt(deposits[selectedDepositIdx]?.value || "0")
                    : "—"
                }
                className="w-full bg-transparent px-4 py-3 font-mono text-[14px] tabular-nums text-black outline-none placeholder:text-gray-400"
              />
              <span className="px-4 font-inter text-[12px] text-gray-500">
                {symbol}
              </span>
            </div>
          </label>
        </div>

        <div className="mt-6 flex items-center gap-4">
          <button
            onClick={handleWithdraw}
            disabled={
              !isConnected ||
              selectedDepositIdx < 0 ||
              withdrawStatus === "proving" ||
              withdrawStatus === "submitting"
            }
            className="rounded-md bg-indigo-600 px-5 py-3 font-syne text-[12px] uppercase tracking-[0.14em] text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {!isConnected
              ? "Connect wallet"
              : selectedDepositIdx < 0
              ? "Select a deposit first"
              : withdrawStatus === "proving"
              ? "Generating proof…"
              : withdrawStatus === "submitting"
              ? "Submitting settle tx…"
              : withdrawStatus === "done"
              ? "Withdraw again"
              : "Withdraw privately"}
          </button>
          {selectedDepositIdx >= 0 && (
            <span className="font-mono text-[11px] text-gray-500">
              Using deposit · {deposits[selectedDepositIdx]?.txHash.slice(0, 10)}…
            </span>
          )}
        </div>

        {/* Opt-in PUBLIC self-exit (ragequit) — escape hatch, not private. */}
        {isConnected && selectedDepositIdx >= 0 && (
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleRagequit}
              disabled={
                withdrawStatus === "proving" || withdrawStatus === "submitting"
              }
              className="rounded-md border border-[#deb6a8] bg-transparent px-3 py-1.5 font-inter text-[12px] text-[#6b2e1f] hover:bg-[#f0d6cf] disabled:opacity-50"
              title="Reclaim your deposit directly to this wallet, bypassing the ASP. NOT private — reveals the deposit↔wallet link. Use only if a private withdraw isn't available."
            >
              Reclaim publicly (ragequit)
            </button>
            <span className="font-inter text-[11px] text-gray-500">
              Escape hatch — returns funds to this wallet, <em>not private</em>.
            </span>
          </div>
        )}

        {withdrawStatus === "error" && (
          <div className="mt-4 rounded-md border border-[#deb6a8] bg-[#f0d6cf] px-3 py-2 font-inter text-[12px] text-[#6b2e1f]">
            {withdrawError}
          </div>
        )}
        {withdrawTxHash && (
          <div className="mt-4 flex items-center gap-3 font-mono text-[12px] text-gray-600">
            <span className="font-syne text-[10px] uppercase tracking-[0.14em] text-gray-500">
              settle tx
            </span>
            <a
              href={`https://sepolia.basescan.org/tx/${withdrawTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-black"
            >
              {withdrawTxHash.slice(0, 10)}…{withdrawTxHash.slice(-8)}
            </a>
            <span className="font-inter text-[11px] text-[#3d4a2c]">
              recipient unlinked
            </span>
          </div>
        )}
      </div>

      {/* ── Withdraw code sample ── */}
      <CodeSample
        caption="Withdraw equivalent"
        samples={{
          curl: `# /api/withdraw runs the proof + relay server-side. Body:
curl -X POST https://zbase.app/api/withdraw \\
  -H 'content-type: application/json' \\
  -d '{
    "nullifier": "<from your stored deposit>",
    "secret": "<from your stored deposit>",
    "value": "<from on-chain Deposited event>",
    "label": "<from on-chain Deposited event>",
    "commitment": "<from on-chain Deposited event>",
    "recipient": "${withdrawRecipient || address || "0x…"}"
  }'

# Response: { "success": true, "txHash": "0x…", "proofValid": true }`,
          typescript: `// withdraw via the zBase relay (no on-chain signing for the user)
const res = await fetch("https://zbase.app/api/withdraw", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    nullifier: deposit.nullifier,
    secret: deposit.secret,
    value: deposit.value,
    label: deposit.label,
    commitment: deposit.commitment,
    recipient: "${withdrawRecipient || address || "0x…"}",
    // Optional: partial withdraw
    // amountAtomic: "500000",
  }),
});
const { txHash, proofValid } = await res.json();`,
          python: `import requests

r = requests.post("https://zbase.app/api/withdraw", json={
    "nullifier": deposit["nullifier"],
    "secret": deposit["secret"],
    "value": deposit["value"],
    "label": deposit["label"],
    "commitment": deposit["commitment"],
    "recipient": "${withdrawRecipient || address || "0x…"}",
})
out = r.json()
print(out["txHash"], out["proofValid"])`,
        }}
      />
    </div>
  );
}
