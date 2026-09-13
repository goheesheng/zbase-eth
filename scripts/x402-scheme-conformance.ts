/**
 * Compile-time conformance: ZBaseExactClient IS a @x402/core SchemeNetworkClient.
 *
 * This file exists to be TYPE-CHECKED, not run — `tsx` on it throws, because
 * `client` is a `declare const` with nothing behind it. Check it with:
 *
 *   npm run test:x402-scheme-conformance
 *
 * which runs `tsc --noEmit` over this file specifically. It is NOT covered by the
 * repo's plain `tsc --noEmit`: the root tsconfig excludes both `scripts` and
 * `packages`, so that command never sees this file (verify with `tsc --listFiles`).
 * If that npm script is ever dropped, this file silently stops asserting anything
 * while still looking like a test.
 *
 * So: if @x402/core changes SchemeNetworkClient (or register's signature) in a way
 * that breaks the drop-in integration, that npm script fails here instead of the
 * breakage surfacing in a user's app.
 *
 * The whole adoption story rests on this one line compiling:
 *
 *   client.register("eip155:8453", createZBaseExactClient({ deposit, onNoteRotate }))
 *
 * A mocked unit test cannot prove it — mocks assert our own shape back to us.
 * Only the real interface can.
 */
import { x402Client } from "@x402/core/client";
import { createZBaseExactClient } from "../packages/core/src/x402SchemeClient.js";

const zbase = createZBaseExactClient({
  deposit: { nullifier: "1", secret: "2", value: "990000", label: "3", commitment: "4" },
  onNoteRotate: (n) => void n,
  maxAmountAtomic: "10000",
});

declare const client: x402Client;

// THE assertion. If this stops compiling, the one-line integration is broken.
client.register("eip155:8453", zbase);

export {};
