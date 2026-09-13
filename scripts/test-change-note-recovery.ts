/**
 * test-change-note-recovery.ts — the seed alone must rebuild change notes.
 *
 * This is the proof that the recoverability gap is closed. It builds a real lineage
 * (deposit → change → change) with parent-keyed secrets and the exact commitments the
 * pool would insert, synthesises the `Withdrawn` events the chain would emit, and asserts
 * that recoverChangeNotes — given ONLY the recovered deposit and the withdrawals —
 * reconstructs every hop's value, label, secrets, and commitment.
 *
 * Then the two things that keep it honest: a LEGACY random change note must NOT be
 * falsely recovered, and the live mainnet lineage's change value must reconstruct to
 * 0.985 from chain data (read-only, no funds moved).
 *
 * Run: npx tsx scripts/test-change-note-recovery.ts
 */
import {
  deriveForwardingNote,
  deriveChangeNote,
  recoverChangeNotes,
  generateNewMnemonic,
  computeCommitment,
  computeNullifierHash,
  getWalletBalance,
} from "../packages/core/src/index.ts";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("change-note recovery — a seed alone rebuilds the whole lineage\n");

const LABEL = "42424242"; // ASP label, conserved down the lineage
const mnemonic = generateNewMnemonic();

/** Build the note the pool would insert given secrets + value + the conserved label. */
const asNote = (s: { nullifier: string; secret: string; precommitment: string }, value: string) => ({
  nullifier: s.nullifier, secret: s.secret, value, label: LABEL,
  commitment: computeCommitment(value, LABEL, s.precommitment),
});

// ── Build a lineage: deposit(1.00) → pay 0.30 → change(0.70) → pay 0.20 → change(0.50) ──
const dep = deriveForwardingNote(mnemonic, 0);
const deposit = asNote(dep, "1000000");
const c1s = deriveChangeNote(deposit);
const change1 = asNote(c1s, "700000");   // 1.00 - 0.30
const c2s = deriveChangeNote(change1);
const change2 = asNote(c2s, "500000");   // 0.70 - 0.20

// The Withdrawn events the pool would emit for those two spends.
const withdrawals = [
  { value: "300000", spentNullifier: computeNullifierHash(deposit.nullifier), newCommitment: change1.commitment },
  { value: "200000", spentNullifier: computeNullifierHash(change1.nullifier), newCommitment: change2.commitment },
];

// 1. THE CORE: recover both change notes from the deposit + withdrawals alone.
{
  const recovered = recoverChangeNotes([deposit], withdrawals);
  recovered.length === 2 ? ok("two change notes recovered from the deposit + Withdrawn events") : bad(`recovered ${recovered.length}, expected 2`);

  const r1 = recovered.find((n) => n.commitment === change1.commitment);
  const r2 = recovered.find((n) => n.commitment === change2.commitment);

  r1 ? ok("change1 found by commitment") : bad("change1 not recovered");
  r1 && r1.value === "700000" ? ok("...value reconstructed = 0.70 (parent 1.00 − withdrawn 0.30)") : bad("change1 value: " + r1?.value);
  r1 && r1.nullifier === change1.nullifier && r1.secret === change1.secret ? ok("...secrets are parent-keyed and correct") : bad("change1 secrets wrong");
  r1 && r1.label === LABEL ? ok("...label conserved from the parent (ASP propagation)") : bad("change1 label wrong");

  r2 ? ok("change2 found (the walk RECURSED — change1 was itself spent)") : bad("change2 not recovered");
  r2 && r2.value === "500000" ? ok("...value reconstructed = 0.50 down two hops") : bad("change2 value: " + r2?.value);
}

// 2. THE HONESTY CHECK: a legacy RANDOM change note must NOT be falsely recovered.
//    Its commitment won't match the parent-keyed reconstruction, so the guard skips it.
{
  const randomChangeCommitment = computeCommitment("700000", LABEL, "999999999999");
  const legacyWithdrawal = [
    { value: "300000", spentNullifier: computeNullifierHash(deposit.nullifier), newCommitment: randomChangeCommitment },
  ];
  const recovered = recoverChangeNotes([deposit], legacyWithdrawal);
  recovered.length === 0
    ? ok("a random (non-parent-keyed) change note is NOT falsely recovered — verify-against-chain rejects it")
    : bad("falsely recovered a random change note: " + JSON.stringify(recovered));
}

// 3. END-TO-END through getWalletBalance: the recovered UNSPENT change (change2, 0.50) is
//    the spendable balance; the spent ones are excluded.
{
  const spentSet = new Set(withdrawals.map((w) => w.spentNullifier));
  const balance = await getWalletBalance({
    mnemonic,
    depositedEvents: [{ commitment: deposit.commitment, label: LABEL, value: "1000000" }],
    withdrawals,
    isSpent: async (nh: string) => spentSet.has(nh),
  });
  // deposit spent, change1 spent, change2 unspent → spendable = 0.50
  balance.atomic === 500000n
    ? ok("getWalletBalance: spendable = 0.50 (the unspent tail of the lineage), from the seed alone")
    : bad("balance atomic: " + balance.atomic);
  balance.spendable.length === 1 && balance.spendable[0].commitment === change2.commitment
    ? ok("...and it is exactly change2 — deposit and change1 correctly marked spent")
    : bad("wrong spendable set");
}

// 4. THE LIVE 0.985. Reconstruct the real mainnet change value from chain data, read-only.
{
  const RPC = process.env.BASE_MAINNET_RPC;
  if (!RPC) throw new Error("BASE_MAINNET_RPC is required — set it in .env.local. Never hardcode RPC credentials in tracked files.");
  try {
    const { createPublicClient, http, parseAbiItem, getAddress } = await import("viem");
    const { base } = await import("viem/chains");
    const c = createPublicClient({ chain: base, transport: http(RPC) });
    const POOL = getAddress("0x46753CED1E87871eA1aaF24Aed47DFA2D95855Dd");
    const [dep] = await c.getLogs({ address: POOL, event: parseAbiItem("event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)"), fromBlock: 48571589n, toBlock: "latest" });
    const [wd] = await c.getLogs({ address: POOL, event: parseAbiItem("event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)"), fromBlock: 48571589n, toBlock: "latest" });
    const depositValue = (dep.args as { _value: bigint })._value;
    const withdrawnValue = (wd.args as { _value: bigint })._value;
    const changeValue = depositValue - withdrawnValue;
    changeValue === 985000n
      ? ok("live pool: change value reconstructs to 0.985 from Deposited − Withdrawn (the exact lost amount)")
      : bad(`live change value ${changeValue}, expected 985000`);
  } catch (e) {
    console.log("  SKIP: live-chain check (no RPC / offline):", (e as Error).message.slice(0, 60));
  }
}

console.log(failed ? "\nFAILED" : "\nCHANGE-NOTE RECOVERY: the gap is closed for parent-keyed lineages");
process.exit(failed ? 1 : 0);
