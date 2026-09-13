"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import {
  ENTRYPOINT_ADDRESS,
  USDC_POOL_ADDRESS,
  USDC_ADDRESS,
  DEPOSIT_ERC20_ABI,
  POOL_ABI,
  USDC_ABI,
} from "@/lib/wagmi";
import {
  generateDepositSecrets,
} from "@/lib/privacy";
import { useChain } from "@/lib/chain-context";
import { ChainSelector } from "@/components/ChainSelector";
import { WalletConnect } from "@/components/WalletConnect";
import EarlyProductNotice from "@/components/EarlyProductNotice";
import { Logo } from "@/app/_components/Logo";
import TryWithoutWallet from "./_components/TryWithoutWallet";
import {
  useDepositVault,
  getVaultDeposits,
  ensureNoteSeed,
  nextDepositIndex,
} from "@/lib/deposit-vault";
import { deriveForwardingNote } from "@zbase-protocol/core/wallet";
import { confirmDepositForAsp } from "@/lib/asp-confirm-client";

type Tab = "deposit" | "withdraw" | "pay" | "integrate";

// Phase 1C: deposit secrets moved off plaintext localStorage into the
// encrypted vault (src/lib/deposit-vault.ts — wallet-signature-derived
// AES-GCM, server stores ciphertext only). The vault module still reads the
// legacy zbase-/zx402- localStorage keys until a durable migration confirms.
type StoredDeposit = {
  nullifier: string;
  secret: string;
  precommitment?: string;
  label: string;
  commitment: string;
  value: string;
  amount: string;
  asset: string;
  txHash: string;
  timestamp: number;
  zkReady?: boolean;
  withdrawn?: boolean;
  /**
   * HD derivation index, when this note came from the vault seed. Present ⇒ the note
   * is re-derivable and nextDepositIndex() will not reuse the slot. Absent ⇒ a legacy
   * random note: its secrets above are the ONLY copy of that money.
   */
  index?: number;
  /** legacy pre-ZK record shape */
  secrets?: string;
};

export default function Home() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { chain, chainId, isEvm, isSvm, chainReady } = useChain();
  // EarlyProductNotice decides for itself (from /api/facilitator/supported) whether to
  // show, so it reports back up — the fixed nav below is positioned against the exact
  // stack height and would sit under a banner it did not know about.
  const [earlyNoticeShown, setEarlyNoticeShown] = useState(false);
  const {
    deposits: vaultDeposits,
    status: vaultStatus,
    error: vaultError,
    unlock: unlockDepositVault,
    save: saveDepositVault,
  } = useDepositVault<StoredDeposit>(address);

  const [activeTab, setActiveTab] = useState<Tab>("deposit");
  const [activeSection, setActiveSection] = useState("hero");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track which section is visible for navbar highlighting
  useEffect(() => {
    const sections = document.querySelectorAll(".snap-section[data-section]");
    const appSections = ["deposit", "withdraw", "pay", "integrate", "explain"];

    const observer = new IntersectionObserver(
      (entries) => {
        // Only care about sections entering view
        const entering = entries.filter(e => e.isIntersecting);
        if (entering.length === 0) return;

        // Pick the one with the most visibility
        const best = entering.reduce((a, b) => a.intersectionRatio > b.intersectionRatio ? a : b);
        const section = best.target.getAttribute("data-section") || "hero";

        // Debounce 150ms so fast scrolling settles before updating
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
          setActiveSection(section);
          if (appSections.includes(section)) {
            setActiveTab(section as Tab);
          }
        }, 150);
      },
      { threshold: 0.5 }
    );
    sections.forEach((s) => observer.observe(s));
    return () => {
      observer.disconnect();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [isConnected]);

  // Refs for scroll-to-section
  const depositSectionRef = useRef<HTMLElement>(null);
  const withdrawSectionRef = useRef<HTMLElement>(null);
  const paySectionRef = useRef<HTMLElement>(null);
  const integrateSectionRef = useRef<HTMLElement>(null);

  // Deposit state
  const [depositAmount, setDepositAmount] = useState("");
  const depositAsset = "USDC"; // Only USDC supported by this pool
  const [depositStatus, setDepositStatus] = useState<"idle" | "approving" | "depositing" | "done" | "error">("idle");
  const [depositError, setDepositError] = useState("");
  const [depositTxHash, setDepositTxHash] = useState("");

  // Withdrawal state
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawStatus, setWithdrawStatus] = useState<"idle" | "scanning" | "proving" | "withdrawing" | "done" | "error">("idle");
  const [withdrawError, setWithdrawError] = useState("");
  const [withdrawTxHash, setWithdrawTxHash] = useState("");
  const [proofTime, setProofTime] = useState(0);

  // Pool stats
  const { data: usdcTreeSize } = useReadContract({
    address: USDC_POOL_ADDRESS,
    abi: POOL_ABI,
    functionName: "currentTreeSize",
  });

  // No ETH pool on this entrypoint -- skip the read
  const ethTreeSize = 0;

  const { data: usdcBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [USDC_POOL_ADDRESS],
  });

  const { data: userUsdcBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
  });

  const { writeContractAsync } = useWriteContract();

  // Get USDC pool scope
  const { data: usdcScope } = useReadContract({
    address: USDC_POOL_ADDRESS,
    abi: POOL_ABI,
    functionName: "SCOPE",
  });

  // Deposit USDC
  const handleDepositUSDC = useCallback(async () => {
    if (!address || !publicClient) return;
    setDepositStatus("approving");
    setDepositError("");
    setDepositTxHash("");

    try {
      const amount = parseUnits(depositAmount, 6);

      // Deposit secrets. PREFER seed-derived: a note's nullifier/secret ARE the money
      // and are handed over once, so a random note that outlives its backup is gone
      // forever (0.985 USDC, 2026-07-16). Derived from the vault's BIP39 seed, a wiped
      // device rebuilds every note from a chain scan.
      //
      // Falls back to random when there is no seed — a locked vault, an un-migrated v1
      // vault, or an ERC-1271 wallet (which may sign non-deterministically and so never
      // unlocks; see vault-messages.ts). Random is the status quo, not a regression;
      // depositing against a seed we could not durably persist would be strictly worse.
      //
      // The index comes from the CHAIN, never from vault length: the vault is a union
      // merge that can shrink, and a fresh install would restart at 0 → duplicate
      // commitment → unspendable deposit. `register/route.ts` already calls its own
      // nextIndex "advisory only".
      const seed = await ensureNoteSeed(address);
      const derivedIndex = seed ? nextDepositIndex(address) : -1;
      const derived = seed ? deriveForwardingNote(seed, derivedIndex) : null;
      const secrets = derived
        ? {
            nullifier: BigInt(derived.nullifier),
            secret: BigInt(derived.secret),
            precommitment: BigInt(derived.precommitment),
          }
        : generateDepositSecrets(amount, 0n);

      // Step 1: Check existing allowance, only approve if needed
      const currentAllowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [address, ENTRYPOINT_ADDRESS],
      }) as bigint;

      if (currentAllowance < amount) {
        setDepositStatus("approving");
        const maxApproval = 2n ** 256n - 1n;
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: "approve",
          args: [ENTRYPOINT_ADDRESS, maxApproval],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      // Step 2: Deposit with Poseidon precommitment
      setDepositStatus("depositing");
      const depositTx = await writeContractAsync({
        address: ENTRYPOINT_ADDRESS,
        abi: DEPOSIT_ERC20_ABI,
        functionName: "deposit",
        args: [USDC_ADDRESS, amount, secrets.precommitment],
        gas: 1_000_000n, // Pool deposit needs ~600K (Poseidon + Merkle + downstream supply)
      });

      setDepositTxHash(depositTx);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });

      // Parse the Deposited event from the pool
      // Event: Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)
      const DEPOSITED_TOPIC = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
      let onChainLabel = 0n;
      let onChainCommitment = 0n;
      let onChainValue = 0n;
      let eventFound = false;

      console.log("[zBase] Scanning", receipt.logs.length, "logs for Deposited event from pool", USDC_POOL_ADDRESS);

      for (const log of receipt.logs) {
        const matchesPool = log.address.toLowerCase() === USDC_POOL_ADDRESS.toLowerCase();
        const matchesTopic = log.topics[0] === DEPOSITED_TOPIC;

        if (matchesPool && matchesTopic) {
          const data = log.data as string;
          console.log("[zBase] Found Deposited event, data length:", data?.length);

          if (!data || data.length < 258) {
            console.warn("[zBase] Event data too short:", data?.length, "expected >= 258");
            continue;
          }

          try {
            onChainCommitment = BigInt("0x" + data.slice(2, 66));
            onChainLabel = BigInt("0x" + data.slice(66, 130));
            onChainValue = BigInt("0x" + data.slice(130, 194));
            eventFound = true;
            console.log("[zBase] Parsed: commitment=" + onChainCommitment.toString().slice(0, 15) + "..., label=" + onChainLabel.toString().slice(0, 15) + "..., value=" + onChainValue.toString());
          } catch (parseErr) {
            console.error("[zBase] Failed to parse event data:", parseErr);
          }
          break;
        }
      }

      if (!eventFound || onChainLabel === 0n || onChainValue === 0n) {
        console.error("[zBase] Deposited event not found or parsed incorrectly");
        console.error("[zBase] Logs from receipt:", receipt.logs.map(l => ({ addr: l.address, topic0: l.topics[0]?.slice(0, 10) })));
        setDepositError("Failed to parse deposit event. Check console for details.");
        setDepositStatus("error");
        return;
      }

      // Save secrets + on-chain data for withdrawal (encrypted vault when
      // unlocked; localStorage crash-safety fallback otherwise)
      saveDepositVault((prev) => [
        ...prev,
        {
          nullifier: secrets.nullifier.toString(),
          secret: secrets.secret.toString(),
          precommitment: secrets.precommitment.toString(),
          label: onChainLabel.toString(),
          commitment: onChainCommitment.toString(),
          value: onChainValue.toString(),
          amount: depositAmount,
          asset: "USDC",
          txHash: depositTx,
          timestamp: Date.now(),
          zkReady: true,
          // Record the HD index for derived notes ONLY. nextDepositIndex() takes
          // max(index)+1, so stamping a random note with an index would burn a slot the
          // seed still owns — the seed would later derive into it and mint a duplicate
          // commitment. Absent index correctly marks "this note is not derivable".
          ...(derived ? { index: derivedIndex } : {}),
        },
      ]);

      // Prove the confirmed pool deposit to the server. The server owns the
      // ASP credential and POSTMAN signer; neither is exposed to this browser.
      try {
        console.log("[zBase] Confirming deposit for ASP inclusion...");
        const asp = await confirmDepositForAsp(depositTx);
        if (asp.status === "rejected") {
          throw new Error(
            "Deposit was rejected by association policy and cannot withdraw privately.",
          );
        }
        console.log("[zBase] ASP inclusion confirmed:", asp.root);
        setDepositStatus("done");
      } catch (aspErr) {
        const message = (aspErr as Error).message || "ASP inclusion failed";
        console.warn("[zBase] Deposit confirmed but ASP inclusion failed:", message);
        setDepositError(`Deposit confirmed on-chain, but ${message}`);
        setDepositStatus("error");
      }
    } catch (err) {
      setDepositError((err as Error).message?.slice(0, 200) || "Transaction failed");
      setDepositStatus("error");
    }
  }, [address, publicClient, depositAmount, writeContractAsync, usdcScope, saveDepositVault]);
  // Note: usdcScope is optional -- real label comes from on-chain Deposited event

  // Deposit ETH
  // ETH deposit removed -- this pool only supports USDC

  // Scroll to a tab section
  const scrollToTab = (tab: Tab) => {
    setActiveTab(tab);
    const refMap: Record<Tab, React.RefObject<HTMLElement | null>> = {
      deposit: depositSectionRef,
      withdraw: withdrawSectionRef,
      pay: paySectionRef,
      integrate: integrateSectionRef,
    };
    refMap[tab]?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      {/* Global styles for scroll-snap, fonts, and decorative elements */}
      <style jsx global>{`
        html {
          scroll-snap-type: y proximity;
          overflow-y: scroll;
          scroll-behavior: smooth;
        }
        .snap-section {
          scroll-snap-align: start;
          min-height: 100vh;
        }
        .font-syne {
          font-family: var(--font-syne), 'Syne', sans-serif;
        }
        .font-inter {
          font-family: var(--font-inter), 'Inter', sans-serif;
        }

        /* Halftone dot pattern */
        .halftone::before {
          content: '';
          position: absolute;
          inset: 0;
          background-image: radial-gradient(circle, #c4b5fd 1.5px, transparent 1.5px);
          background-size: 16px 16px;
          opacity: 0.3;
          pointer-events: none;
          z-index: 0;
          mask-image: radial-gradient(ellipse 70% 80% at 55% 40%, black 0%, transparent 70%);
          -webkit-mask-image: radial-gradient(ellipse 70% 80% at 55% 40%, black 0%, transparent 70%);
        }

        /* Lock/keyhole shape */
        .hero-bg-shape {
          position: absolute;
          top: 5%;
          left: 25%;
          width: 550px;
          height: 700px;
          z-index: 0;
          opacity: 0.08;
          background-image: radial-gradient(circle, #6366f1 2px, transparent 2px);
          background-size: 10px 10px;
          clip-path: path('M275 0 C380 0 460 70 460 160 L460 260 L500 260 L500 700 L50 700 L50 260 L90 260 L90 160 C90 70 170 0 275 0 Z M275 60 C200 60 150 105 150 160 L150 260 L400 260 L400 160 C400 105 350 60 275 60 Z');
        }

        /* Purple mesh dots */
        .agent-bg-grid {
          position: absolute;
          bottom: 10%;
          left: 5%;
          width: 400px;
          height: 400px;
          z-index: 0;
          opacity: 0.04;
          background-image: radial-gradient(circle, #6366f1 3px, transparent 3px);
          background-size: 40px 40px;
          mask-image: radial-gradient(ellipse 100% 100% at 50% 50%, black 20%, transparent 70%);
          -webkit-mask-image: radial-gradient(ellipse 100% 100% at 50% 50%, black 20%, transparent 70%);
        }

        /* Responsive adjustments */
        @media (max-width: 900px) {
          .hero-grid-40-60 {
            grid-template-columns: 1fr !important;
            gap: 40px !important;
          }
          .compliance-grid-60-40 {
            grid-template-columns: 1fr !important;
            gap: 32px !important;
          }
          .headline-massive-76 {
            font-size: 52px !important;
          }
          .headline-section-38 {
            font-size: 28px !important;
          }
          .x402-hero-80 {
            font-size: 48px !important;
          }
          .section-number-el {
            display: none !important;
          }
          .flow-cards-row {
            flex-direction: column !important;
            gap: 12px !important;
          }
          .flow-cards-row .flow-arrow-el {
            transform: rotate(90deg);
          }
          .x402-stats-row-el {
            flex-direction: column !important;
            gap: 24px !important;
          }
        }

        @media (max-width: 480px) {
          .headline-massive-76 {
            font-size: 44px !important;
          }
          .x402-hero-80 {
            font-size: 36px !important;
          }
          .stat-grid-2x2 {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

      <main className="bg-[#f8f7f4] text-black font-inter">
        {/* ── HONEST DISCLOSURE: EARLY PRODUCT ──
            Payments settle but are not private until the anonymity set is large enough.
            Self-hides when it is — reads customerReady, nobody flips it. */}
        <EarlyProductNotice onVisible={setEarlyNoticeShown} />

        {/* ── HONEST DISCLOSURE BANNER ──
            Solana is paused by default while SVM audit fixes are applied.
            Sits BELOW the early-product strip when both are up. */}
        {!chainReady && (
          <div className={`fixed left-0 right-0 z-[60] bg-amber-100 border-b border-amber-300 text-amber-900 text-[12px] font-inter font-medium px-6 py-2 text-center ${earlyNoticeShown ? "top-[34px]" : "top-0"}`}>
            Solana deposits are paused while SVM audit fixes are applied. Use the Base flow for launch work. Re-enable only after setting <code>NEXT_PUBLIC_ZX402_SVM_READY=true</code> intentionally.{" "}
            <a href="https://github.com/goheesheng/zx402/blob/main/STATUS.md" target="_blank" rel="noopener noreferrer" className="underline">STATUS.md</a>
          </div>
        )}
        {/* ── STICKY NAV ── */}
        {/* Nav clears whichever disclosure strips are up: 34px each, stacked. */}
        <nav className={`fixed left-0 right-0 z-50 flex items-center px-14 h-[72px] bg-[#f8f7f4]/85 backdrop-blur-[12px] border-b border-gray-200 ${
          !chainReady && earlyNoticeShown ? "top-[68px]" : !chainReady || earlyNoticeShown ? "top-[34px]" : "top-0"
        }`}>
          <Logo size={32} tone="ink" accent="var(--hot)" />


          {/* Center: Unified pill nav — absolutely centered in the navbar */}
          {/* Center: All section pills in sequence, highlights active */}
          <div className="hidden md:flex items-center absolute left-1/2 -translate-x-1/2">
            <div className="flex gap-0.5 bg-white/90 backdrop-blur-lg border border-gray-200 rounded-full px-1.5 py-1">
              {[
                { id: "hero", label: "Home" },
                { id: "try", label: "Demo" },
                { id: "explain", label: "Explain" },
                { id: "compliance", label: "Compliance" },
                { id: "deposit", label: "Deposit" },
                { id: "withdraw", label: "Withdraw" },
                { id: "pay", label: "Agents" },
                { id: "integrate", label: "Integrate" },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    const el = document.querySelector(`[data-section="${item.id}"]`);
                    if (el) {
                      el.scrollIntoView({ behavior: "smooth" });
                    } else {
                      scrollToTab(item.id as Tab);
                    }
                  }}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium font-inter transition-all duration-200 ${
                    activeSection === item.id
                      ? "bg-indigo-500 text-white shadow-sm"
                      : "text-gray-400 hover:text-black hover:bg-gray-100"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ml-auto shrink-0 flex items-center gap-3">
            <ChainSelector />
            <WalletConnect />
          </div>
        </nav>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 0: HERO -- 40/60 split
            ════════════════════════════════════════════════════════════════ */}
        <section data-section="hero" className="snap-section relative flex flex-col justify-center px-12 pt-[120px] pb-20 halftone">
          <div className="hero-bg-shape" />
          <div className="relative z-10 max-w-[1200px] mx-auto w-full">
            <div className="grid hero-grid-40-60 gap-16 items-center" style={{ gridTemplateColumns: "40fr 60fr", minHeight: "calc(100vh - 160px)" }}>
              {/* Left 40%: headline + subtitle + buttons */}
              <div className="flex flex-col justify-center">
                <h1 className="font-syne font-bold headline-massive-76 leading-[1.08] tracking-[-2px] text-black" style={{ fontSize: 76 }}>
                  Private payments<br />for AI agents.
                </h1>
                <p className="font-inter text-base text-gray-500 leading-relaxed mt-6">
                  {isSvm
                    ? "Private USDC on Solana. Pay AI agents. Withdraw anywhere."
                    : "Private USDC on Base. Pay AI agents. Withdraw anywhere."}
                </p>
                <div className="flex gap-4 mt-8">
                  {(!isConnected && isEvm) ? (
                    <ConnectButton />
                  ) : (!isConnected && isSvm) ? (
                    <WalletConnect />
                  ) : !chainReady ? (
                    <button
                      disabled
                      title="Solana paused pending audit fixes — see STATUS.md"
                      className="inline-flex items-center gap-2 font-inter font-semibold text-[15px] px-7 py-3.5 rounded-[10px] bg-gray-300 text-gray-600 cursor-not-allowed"
                    >
                      Deposits paused (Solana)
                    </button>
                  ) : (
                    <button
                      onClick={() => scrollToTab("deposit")}
                      className="inline-flex items-center gap-2 font-inter font-semibold text-[15px] px-7 py-3.5 rounded-[10px] bg-black text-white hover:bg-[#1a1a1a] transition-all"
                    >
                      Deposit USDC
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const el = document.querySelector('[data-section="try"]');
                      if (el) el.scrollIntoView({ behavior: "smooth" });
                    }}
                    className="inline-flex items-center gap-2 font-inter font-semibold text-[15px] px-7 py-3.5 rounded-[10px] border-[1.5px] border-indigo-300 text-indigo-700 hover:border-indigo-600 hover:bg-indigo-50 transition-all"
                  >
                    Try without your wallet
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
                  </button>
                </div>
              </div>

              {/* Right 60%: 2x2 stat cards */}
              <div className="grid grid-cols-2 gap-4">
                {[
                  { value: "233,659", label: "Shielded ETH", color: "bg-lime-500" },
                  { value: "$49.5M", label: "x402 Volume", color: "bg-indigo-500" },
                  { value: "2.25M", label: "x402 Transactions", color: "bg-lime-500" },
                  { value: usdcBalance ? `$${formatUnits(usdcBalance as bigint, 6)}` : "727 ETH", label: usdcBalance ? "Pool TVL (USDC)" : "Privacy Pools TVL", color: "bg-indigo-500" },
                ].map((stat, i) => (
                  <div key={i} className="bg-white border border-gray-200 rounded-2xl shadow-sm" style={{ padding: "28px 28px 24px" }}>
                    <div className="font-inter font-extrabold text-[34px] text-black" style={{ lineHeight: "42px", fontVariantNumeric: "tabular-nums" }}>
                      {stat.value}
                    </div>
                    <div className="flex items-center gap-2 font-inter font-medium text-[13px] text-gray-500" style={{ marginTop: "12px" }}>
                      <span className={`w-2 h-2 rounded-full ${stat.color} inline-block shrink-0`} />
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 0.5: TRY WITHOUT WALLET — folded in from former /demo
            Wired 2026-06-02 per docs/operations/demo-page-runbook (the page
            route was removed; the API at /api/demo/run is unchanged).
            ════════════════════════════════════════════════════════════════ */}
        <section
          id="try"
          data-section="try"
          className="snap-section relative flex flex-col justify-center px-0 pt-[120px] pb-20"
        >
          <TryWithoutWallet />
        </section>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 2: x402 -- full width
            ════════════════════════════════════════════════════════════════ */}
        <section data-section="explain" className="snap-section relative flex flex-col justify-center px-12 pt-[120px] pb-20 border-l border-r border-gray-200 mx-6 halftone">
          <div className="agent-bg-grid" />
          <span className="section-number-el absolute top-1/2 -translate-y-1/2 -left-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>02</span>
          <span className="section-number-el absolute top-1/2 -translate-y-1/2 -right-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>02</span>

          <div className="relative z-10 max-w-[1200px] mx-auto w-full">
            {/* Pill */}
            <div className="text-center mb-10">
              <div className="flex items-center justify-center gap-4">
                <span className="w-10 h-px bg-gray-200" />
                <span className="inline-flex items-center gap-2 font-inter font-semibold text-xs uppercase tracking-[0.08em] px-[18px] py-1.5 rounded-full bg-lime-600 text-white">
                  x402 Private Payments
                </span>
                <span className="w-10 h-px bg-gray-200" />
              </div>
            </div>

            {/* Watermark number */}
            <div className="font-inter font-extrabold text-black/[0.08] leading-none text-center" style={{ fontSize: 72, fontVariantNumeric: "tabular-nums" }}>
              2,249,444
            </div>
            <div className="font-inter font-medium text-base text-gray-500 text-center mt-2 mb-12">
              x402 transactions last month. All public on-chain. Until now.
            </div>

            {/* Flow cards */}
            <div className="flex flow-cards-row items-center justify-center flex-wrap gap-0">
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-center w-[220px] shadow-sm">
                <div className="font-inter font-semibold text-[11px] text-indigo-500 tracking-[0.1em] uppercase mb-2.5">Step 1</div>
                <div className="font-inter font-medium text-sm text-black leading-relaxed">Agent requests payment</div>
              </div>
              <div className="flow-arrow-el text-xl text-gray-400 mx-3 shrink-0">&rarr;</div>
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-center w-[220px] shadow-sm">
                <div className="font-inter font-semibold text-[11px] text-indigo-500 tracking-[0.1em] uppercase mb-2.5">Step 2</div>
                <div className="font-inter font-medium text-sm text-black leading-relaxed">zBase generates ZK proof</div>
              </div>
              <div className="flow-arrow-el text-xl text-gray-400 mx-3 shrink-0">&rarr;</div>
              <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-center w-[220px] shadow-sm">
                <div className="font-inter font-semibold text-[11px] text-indigo-500 tracking-[0.1em] uppercase mb-2.5">Step 3</div>
                <div className="font-inter font-medium text-sm text-black leading-relaxed">Payment settled privately</div>
              </div>
            </div>

            {/* Stats row */}
            <div className="flex x402-stats-row-el justify-center gap-16 mt-12 pt-8 border-t border-gray-200">
              {[
                { value: "$49.5M", label: "Payment Volume", color: "bg-indigo-500" },
                { value: "118,752", label: "Buyers", color: "bg-lime-500" },
                { value: "2.25M", label: "Transactions", color: "bg-indigo-500" },
              ].map((stat, i) => (
                <div key={i} className="text-center">
                  <div className="font-inter font-extrabold text-[32px] text-black" style={{ lineHeight: "40px", fontVariantNumeric: "tabular-nums" }}>{stat.value}</div>
                  <div className="flex items-center justify-center gap-1.5 font-inter font-medium text-sm text-gray-500 mt-2.5">
                    <span className={`w-2 h-2 rounded-full ${stat.color} inline-block`} />
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 3: COMPLIANCE -- 60/40 split
            ════════════════════════════════════════════════════════════════ */}
        <section data-section="compliance" className="snap-section relative flex flex-col justify-center px-12 pt-[120px] pb-20 border-l border-r border-gray-200 mx-6">
          <span className="section-number-el absolute top-1/2 -translate-y-1/2 -left-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>03</span>
          <span className="section-number-el absolute top-1/2 -translate-y-1/2 -right-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>03</span>

          <div className="relative z-10 max-w-[1200px] mx-auto w-full">
            <div className="grid compliance-grid-60-40 gap-16 items-start" style={{ gridTemplateColumns: "60fr 40fr" }}>
              {/* Left 60%: green pill + headline + subtext */}
              <div className="flex flex-col gap-6">
                <div>
                  <span className="inline-flex items-center gap-2 font-inter font-semibold text-xs uppercase tracking-[0.08em] px-[18px] py-1.5 rounded-full bg-lime-600 text-white">
                    Compliant Privacy
                  </span>
                </div>
                <h2 className="font-syne font-bold headline-section-38 leading-[1.35] tracking-[-1px] text-black" style={{ fontSize: 38 }}>
                  The missing infrastructure<br />
                  for AI agents.<br />
                  Identity. Permissions. Payments.<br />
                  All private. All compliant.
                </h2>
                <p className="font-inter text-base text-gray-500 leading-relaxed">
                  a16z flagged the gap: agents can&apos;t prove who they represent, what they&apos;re allowed to do, or how they get paid.
                  zBase solves all three with ZK proofs, agent registry, and the x402 facilitator. Built on Vitalik&apos;s Privacy Pools.
                </p>
              </div>

              {/* Right 40%: a16z solutions + compliance badges */}
              <div className="flex flex-col gap-3 pt-2">
                <div className="flex items-center gap-3 font-inter font-semibold text-sm text-black px-5 py-3.5 border border-indigo-200 rounded-[10px] bg-indigo-50 shadow-sm">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500 text-white flex items-center justify-center text-xs font-extrabold shrink-0">ID</div>
                  <div>
                    Agent Identity
                    <div className="font-normal text-xs text-indigo-500 mt-0.5">&quot;Prove who it represents&quot; -- a16z</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 font-inter font-semibold text-sm text-black px-5 py-3.5 border border-indigo-200 rounded-[10px] bg-indigo-50 shadow-sm">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500 text-white flex items-center justify-center text-xs font-extrabold shrink-0">PM</div>
                  <div>
                    Agent Permissions
                    <div className="font-normal text-xs text-indigo-500 mt-0.5">&quot;What it&apos;s allowed to do&quot; -- a16z</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 font-inter font-semibold text-sm text-black px-5 py-3.5 border border-lime-200 rounded-[10px] bg-lime-50 shadow-sm">
                  <div className="w-8 h-8 rounded-lg bg-lime-600 text-white flex items-center justify-center text-xs font-extrabold shrink-0">ZK</div>
                  <div>
                    Private Payments
                    <div className="font-normal text-xs text-lime-600 mt-0.5">&quot;How it gets paid&quot; -- a16z (+ privacy)</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 font-inter font-semibold text-sm text-black px-5 py-3.5 border border-gray-200 rounded-[10px] bg-white shadow-sm">
                  <div className="w-8 h-8 rounded-lg bg-gray-800 text-white flex items-center justify-center text-xs font-extrabold shrink-0">V</div>
                  <div>
                    Vitalik + EF + Apache 2.0
                    <div className="font-normal text-xs text-gray-500 mt-0.5">Privacy Pools research, compliant by design</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Roadmap-honesty pill — yield narrative was deferred from the
                consumer hero (2026-06-02) but the Morpho/Kamino integration
                is on the protocol roadmap. Surface it here so we're not
                hiding the future feature, just not selling it as shipped. */}
            <div className="mt-12 flex justify-center">
              <span className="inline-flex items-center gap-2 font-inter text-[11px] uppercase tracking-[0.14em] text-[#6b5417] bg-[#f3e7c8] border border-[#e2d09a] px-4 py-1.5 rounded-full">
                <span className="font-mono">●</span>
                Yield integration (Morpho · Kamino) — coming soon
              </span>
            </div>
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════════
            SECTION 4: DEPOSIT CTA / FUNCTIONAL DEPOSIT
            ════════════════════════════════════════════════════════════════ */}
        <section
          data-section="deposit"
          ref={depositSectionRef}
          className="snap-section relative flex flex-col justify-center px-12 pt-[120px] pb-20 border-l border-r border-gray-200 mx-6 halftone"
        >
          <span className="section-number-el absolute top-1/2 -translate-y-1/2 -left-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>04</span>
          <span className="section-number-el absolute top-1/2 -translate-y-1/2 -right-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>04</span>

          <div className="relative z-10 max-w-[1200px] mx-auto w-full">
            {/* Zero stat */}
            <div className="text-center mb-10">
              <div className="font-inter font-extrabold text-[64px] text-indigo-500" style={{ lineHeight: "72px", fontVariantNumeric: "tabular-nums" }}>
                {(usdcTreeSize ? Number(usdcTreeSize) : 0) + (ethTreeSize ? Number(ethTreeSize) : 0)}
              </div>
              <div className="font-inter font-medium text-base text-gray-500 mt-2">
                {(usdcTreeSize ? Number(usdcTreeSize) : 0) > 0
                  ? "deposits in the privacy pool"
                  : "privacy protocols on Base -- until now"}
              </div>
            </div>

            {/* Deposit card */}
            <div className="bg-white border-[1.5px] border-gray-200 rounded-2xl p-10 max-w-[560px] mx-auto shadow-[0_4px_24px_rgba(0,0,0,0.04)]">
              {/* Solana deposit panel */}
              {isSvm ? (
                <div className="space-y-6">
                  <div className="text-center">
                    <div className="inline-flex items-center gap-2 px-4 py-2 bg-purple-50 border border-purple-200 rounded-full mb-4">
                      <span className="text-lg">◎</span>
                      <span className="font-inter font-medium text-sm text-purple-700">Solana Devnet</span>
                    </div>
                    <h3 className="font-syne font-bold text-2xl text-black">Deposit USDC to Privacy Pool</h3>
                    <p className="font-inter text-sm text-gray-500 mt-2">
                      Your USDC enters the ZK privacy pool on Solana. Withdraw to any address — no on-chain link to your deposit.
                    </p>
                  </div>
                  <div className="bg-[#f8f7f4] border border-gray-200 rounded-xl p-5 space-y-3">
                    <div className="flex justify-between font-inter text-sm">
                      <span className="text-gray-500">Program</span>
                      <a href={`${chain.explorerUrl}/address/${chain.entrypointAddress}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="text-indigo-500 font-mono text-xs hover:underline">
                        {chain.entrypointAddress.slice(0, 8)}...{chain.entrypointAddress.slice(-6)}
                      </a>
                    </div>
                    <div className="flex justify-between font-inter text-sm">
                      <span className="text-gray-500">Pool</span>
                      <span className="font-mono text-xs text-gray-700">{chain.poolAddress.slice(0, 8)}...{chain.poolAddress.slice(-6)}</span>
                    </div>
                    <div className="flex justify-between font-inter text-sm">
                      <span className="text-gray-500">Vetting Fee</span>
                      <span className="text-gray-700">0.5%</span>
                    </div>
                    <div className="flex justify-between font-inter text-sm">
                      <span className="text-gray-500">Min Deposit</span>
                      <span className="text-gray-700">1 USDC</span>
                    </div>
                  </div>
                  {chainReady ? (
                    <>
                      <div className="rounded-xl border border-purple-200 bg-purple-50 p-4 text-purple-900 text-sm font-inter leading-relaxed">
                        <strong>Solana flow today is CLI-driven.</strong> Run the agent test against the live V1 program:
                        <pre className="mt-2 text-xs bg-white border border-purple-200 rounded p-2 font-mono overflow-x-auto">npm run demo:bootstrap{"\n"}npm run test:svm-x402-agent</pre>
                        Each run deposits 1 USDC, generates a Groth16 proof, settles via the on-chain verifier (~150K CU), and pays a recipient — agent wallet absent from the settlement.
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <WalletConnect />
                        <p className="font-inter text-xs text-gray-400 text-center">
                          In-browser Solana deposit is on the roadmap (the SDK is browser-ready; UI wiring next).
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 text-sm font-inter leading-relaxed text-center">
                      <strong>Staging mode.</strong> This frontend is configured for a pre-V1 program at{" "}
                      <span className="font-mono">{chain.entrypointAddress.slice(0, 6)}…{chain.entrypointAddress.slice(-4)}</span>{" "}
                      where on-chain Groth16 verification + ASP enforcement aren&apos;t enabled yet. Do not deposit. The production devnet program is V1; the toggle is <code>NEXT_PUBLIC_ZX402_SVM_READY</code>.{" "}
                      <a
                        href="https://github.com/goheesheng/zx402/blob/main/STATUS.md"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline font-semibold"
                      >
                        STATUS.md
                      </a>
                    </div>
                  )}
                </div>
              ) : !isConnected ? (
                /* EVM: Not connected: show connect button */
                <div className="text-center space-y-6">
                  <p className="font-inter text-sm text-gray-500">Connect your wallet to deposit USDC privately</p>
                  <div className="flex justify-center">
                    <ConnectButton />
                  </div>
                  <p className="font-inter text-xs text-gray-400 leading-relaxed">
                    1% deposit vetting fee (0xbow pool) &middot; 5% take on private settles &middot; Compliant by design
                  </p>
                </div>
              ) : (
                /* Connected: functional deposit form */
                <div className="space-y-5">
                  <div className="flex items-center justify-between mb-2">
                    <label className="font-inter font-medium text-[13px] text-gray-500">Amount</label>
                    {depositAsset === "USDC" && userUsdcBalance && (
                      <span className="font-inter text-xs text-gray-400">
                        Balance: {formatUnits(userUsdcBalance as bigint, 6)} USDC
                      </span>
                    )}
                  </div>
                  <div className="flex items-center border-[1.5px] border-gray-200 rounded-xl bg-[#f8f7f4] focus-within:border-indigo-500 transition-colors overflow-hidden">
                    <input
                      type="text"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                      className="flex-1 border-none outline-none bg-transparent font-inter font-bold text-[28px] px-4 py-4 text-black placeholder:text-gray-300"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    />
                    <div className="flex items-center gap-2 px-4 py-4 border-l border-gray-200 bg-white/60">
                      <svg width="20" height="20" viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                        <circle cx="1000" cy="1000" r="1000" fill="#2775CA"/>
                        <path d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-175v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 216.66 200v100c0 16.66 12.5 29.16 33.34 33.33h62.5c16.66 0 29.16-12.5 33.33-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z" fill="white"/>
                      </svg>
                      <span className="font-inter font-semibold text-sm text-gray-600 whitespace-nowrap">USDC</span>
                    </div>
                  </div>

                  <button
                    onClick={handleDepositUSDC}
                    disabled={depositStatus === "approving" || depositStatus === "depositing" || !depositAmount}
                    className="w-full flex items-center justify-center gap-2 font-inter font-semibold text-base px-7 py-4 rounded-xl bg-indigo-500 text-white hover:bg-indigo-600 transition-all disabled:opacity-50"
                  >
                    {depositStatus === "approving" ? "Approving USDC..." :
                     depositStatus === "depositing" ? "Depositing into Pool..." :
                     depositStatus === "done" ? "Deposited!" :
                     "Approve & Deposit"}
                    {depositStatus === "idle" && (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
                    )}
                  </button>

                  <p className="text-center font-inter text-xs text-gray-400 leading-relaxed mt-4">
                    1% deposit vetting fee (0xbow pool) &middot; 5% take on private settles &middot; Compliant by design
                  </p>

                  {depositError && (
                    <p className="text-xs text-red-600 bg-red-50 rounded-xl p-3 break-all border border-red-200">{depositError}</p>
                  )}

                  {depositStatus === "done" && (
                    <div className="text-xs text-lime-700 bg-lime-50 rounded-xl p-4 space-y-2 border border-lime-200">
                      <p className="font-medium">Deposit successful! Your USDC is shielded in the privacy pool.</p>
                      <p className="text-gray-500">
                        Save your deposit secrets locally (next to your wallet). Use them to withdraw to any address, or pay AI agents privately via x402.
                      </p>
                      {depositTxHash && (
                        <a
                          href={`https://sepolia.basescan.org/tx/${depositTxHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-500 hover:underline block"
                        >
                          View on BaseScan
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ════════════════════════════════════════════════════════════════
            WITHDRAW + PAY + INTEGRATE — always visible to disconnected
            visitors. Withdraw + Pay show static copy + an inline Connect
            Wallet prompt where the form would be. Integrate is fully
            wallet-agnostic and renders identically to connected users.
            ════════════════════════════════════════════════════════════════ */}
        <>
            {/* Tab bar is now in the navbar center — see nav above */}

            {/* ── WITHDRAW SECTION ── */}
            <section
              data-section="withdraw"
              ref={withdrawSectionRef}
              className="snap-section relative flex flex-col justify-center px-12 pt-[120px] pb-20 border-l border-r border-gray-200 mx-6"
            >
              <span className="section-number-el absolute top-1/2 -translate-y-1/2 -left-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>05</span>
              <span className="section-number-el absolute top-1/2 -translate-y-1/2 -right-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>05</span>

              <div className="relative z-10 max-w-[800px] mx-auto w-full space-y-6">
                <div>
                  <span className="inline-flex items-center gap-2 font-inter font-semibold text-xs uppercase tracking-[0.08em] px-[18px] py-1.5 rounded-full bg-indigo-500 text-white mb-4">
                    Private Withdrawal
                  </span>
                  <h2 className="font-syne font-bold text-[32px] leading-tight tracking-[-1px] text-black mt-3">Withdraw from Privacy Pool</h2>
                  <p className="font-inter text-sm text-gray-500 mt-2">
                    {isSvm
                      ? "Withdraw your USDC privately. ZK proof generated off-chain. Nobody can link your withdrawal to your deposit."
                      : "Withdraw your USDC privately. A ZK proof is generated server-side. The proof verifies you own a deposit without revealing which one."}
                  </p>
                </div>

                {/* Solana withdraw info */}
                {isSvm && (
                  <div className="bg-purple-50 border border-purple-200 rounded-2xl p-6 space-y-3">
                    <h3 className="font-syne font-semibold text-lg text-purple-900">Solana Withdrawal Flow</h3>
                    <div className="font-inter text-sm text-purple-800 space-y-2">
                      <p>1. Select your deposit from the list below</p>
                      <p>2. Enter a fresh Solana address (no prior link to your wallet)</p>
                      <p>3. ZK proof is generated off-chain (~10s proof gen)</p>
                      <p>4. Relayer submits the proof on-chain. Pool pays the recipient (~7-15s total per payment on Base Sepolia after the initial deposit).</p>
                      <p>5. Nobody can determine which deposit funded the withdrawal.</p>
                    </div>
                    <div className="flex items-center gap-2 mt-3">
                      <span className="text-xs font-mono text-purple-600">Program: {chain.entrypointAddress.slice(0, 12)}...</span>
                      <a href={`${chain.explorerUrl}/address/${chain.entrypointAddress}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-500 hover:underline">View on Explorer</a>
                    </div>
                  </div>
                )}

                {/* Show local deposits (or Connect prompt if disconnected) */}
                {!isConnected && (
                  <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center space-y-4">
                    <p className="font-inter text-sm text-gray-500">
                      Connect your wallet to view your deposits and withdraw privately.
                    </p>
                    <div className="flex justify-center">
                      <ConnectButton />
                    </div>
                  </div>
                )}
                {address && vaultStatus !== "unlocked" && (
                  <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4 flex items-center justify-between gap-4">
                    <p className="font-inter text-xs text-indigo-900">
                      {vaultStatus === "unlocking"
                        ? "Unlocking your encrypted deposit vault…"
                        : "Move your deposit secrets into an encrypted vault — recoverable from any browser by signing with your wallet, instead of living in this browser's localStorage."}
                      {vaultError && <span className="block mt-1 text-red-600">{vaultError}</span>}
                    </p>
                    <button
                      onClick={() => unlockDepositVault()}
                      disabled={vaultStatus === "unlocking"}
                      className="shrink-0 px-4 py-2 bg-indigo-500 text-white text-xs font-inter font-semibold rounded-xl hover:bg-indigo-600 transition-all disabled:opacity-50"
                    >
                      {vaultStatus === "unlocking" ? "Unlocking…" : "Unlock vault"}
                    </button>
                  </div>
                )}
                {address && (() => {
                  const deposits = vaultDeposits;
                  if (deposits.length === 0) return (
                    <div className="border-2 border-dashed border-gray-200 rounded-2xl p-8 text-center">
                      <p className="text-gray-500 font-inter">No deposits found. Make a deposit first.</p>
                    </div>
                  );
                  return (
                    <div className="space-y-4">
                      <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
                        <h3 className="font-syne font-semibold text-sm text-gray-600 mb-3">
                          Your Deposits {vaultStatus === "unlocked" ? "(encrypted vault)" : "(stored locally)"}
                        </h3>
                        <div className="space-y-2">
                          {deposits.map((d: { amount: string; asset: string; timestamp: number; txHash: string; secrets?: string; zkReady?: boolean; withdrawn?: boolean }, i: number) => (
                            <div key={i} className="flex items-center justify-between text-xs bg-[#f8f7f4] rounded-xl p-3">
                              <div>
                                <span className="text-black font-mono font-medium">{d.amount} {d.asset}</span>
                                <span className="text-gray-400 ml-3">{new Date(d.timestamp).toLocaleDateString()}</span>
                                {d.zkReady && !d.withdrawn && <span className="text-lime-600 ml-2">(ZK-ready)</span>}
                                {d.withdrawn && <span className="text-gray-400 ml-2">(withdrawn)</span>}
                                {!d.zkReady && !d.withdrawn && <span className="text-gray-300 ml-2">(legacy)</span>}
                              </div>
                              <a
                                href={`https://sepolia.basescan.org/tx/${d.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-indigo-400 hover:text-indigo-600"
                              >
                                tx
                              </a>
                            </div>
                          ))}
                        </div>
                        <button
                          onClick={() => {
                            // No reload: the vault hook re-renders on save, and
                            // reloading mid-PUT would cancel the vault write.
                            saveDepositVault(deposits.filter((d: { zkReady?: boolean }) => d.zkReady));
                          }}
                          className="mt-2 text-xs text-gray-400 hover:text-gray-600 underline font-inter"
                        >
                          Clear deposit history
                        </button>
                      </div>

                      {/* Withdrawal form */}
                      <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm space-y-5">
                        <div>
                          <label className="font-inter font-medium text-xs text-gray-500 block mb-2">Withdraw to Address</label>
                          <input
                            type="text"
                            value={withdrawAddress}
                            onChange={(e) => setWithdrawAddress(e.target.value)}
                            placeholder="0x... (any fresh address)"
                            className="w-full bg-[#f8f7f4] border border-gray-200 rounded-xl px-4 py-3 text-sm font-mono placeholder:text-gray-400 focus:outline-none focus:border-indigo-500 transition-colors"
                          />
                          <p className="font-inter text-xs text-gray-400 mt-1">
                            Use a fresh address for maximum privacy. No link to your deposit.
                          </p>
                        </div>

                        <button
                          onClick={async () => {
                            if (!address) return;
                            setWithdrawStatus("proving");
                            setWithdrawError("");
                            setWithdrawTxHash("");
                            const startTime = Date.now();
                            try {
                              // Use the LAST (most recent) ZK-ready deposit
                              const zkReadyDeposits = deposits.filter((d: { zkReady?: boolean; withdrawn?: boolean }) => d.zkReady && !d.withdrawn);
                              const deposit = zkReadyDeposits[zkReadyDeposits.length - 1];
                              if (!deposit) {
                                setWithdrawError("No ZK-ready deposits found. Make a new deposit first.");
                                setWithdrawStatus("error");
                                return;
                              }

                              const recipient = withdrawAddress || address;

                              // Call server-side API for proof generation + relay
                              setWithdrawStatus("proving");
                              const res = await fetch("/api/withdraw", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  nullifier: deposit.nullifier,
                                  secret: deposit.secret,
                                  value: deposit.value,
                                  label: deposit.label,
                                  commitment: deposit.commitment,
                                  recipient,
                                }),
                              });

                              const data = await res.json();
                              setProofTime(Date.now() - startTime);

                              if (!res.ok || data.error) {
                                setWithdrawError(data.error || "Withdrawal failed");
                                setWithdrawStatus("error");
                                return;
                              }

                              setWithdrawTxHash(data.txHash);
                              deposit.withdrawn = true;
                              const next = [...deposits];
                              if (data.nextDeposit) {
                                next.push({
                                  ...data.nextDeposit,
                                  amount: (Number(data.nextDeposit.value) / 1e6).toString(),
                                  asset: "USDC",
                                  txHash: data.txHash,
                                  timestamp: Date.now(),
                                  zkReady: true,
                                });
                              }
                              saveDepositVault(next);
                              setWithdrawStatus("done");
                            } catch (err) {
                              console.error("[zBase] Withdrawal error:", err);
                              setWithdrawError((err as Error).message?.slice(0, 300) || "Withdrawal failed");
                              setWithdrawStatus("error");
                            }
                          }}
                          disabled={withdrawStatus === "proving" || withdrawStatus === "withdrawing"}
                          className="w-full py-3.5 bg-indigo-500 text-white font-inter font-semibold rounded-xl hover:bg-indigo-600 transition-all disabled:opacity-50"
                        >
                          {withdrawStatus === "proving" ? "Generating ZK Proof & Withdrawing..." :
                           withdrawStatus === "done" ? `Privately Withdrawn! (${(proofTime / 1000).toFixed(1)}s)` :
                           "Withdraw Privately with ZK Proof"}
                        </button>

                        {withdrawError && (
                          <p className="text-xs text-red-600 bg-red-50 rounded-xl p-3 break-all border border-red-200">{withdrawError}</p>
                        )}

                        {withdrawStatus === "done" && (
                          <div className="text-xs text-lime-700 bg-lime-50 rounded-xl p-4 space-y-2 border border-lime-200">
                            <p className="font-medium">Private withdrawal complete! Proof generated in {(proofTime / 1000).toFixed(1)}s</p>
                            <p className="text-gray-500">
                              Your funds were withdrawn privately via ZK proof. The Groth16 proof verified
                              on-chain that you owned a valid deposit without revealing which one.
                              The recipient address has no on-chain link to your deposit.
                            </p>
                            {withdrawTxHash && (
                              <a
                                href={`https://sepolia.basescan.org/tx/${withdrawTxHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-indigo-500 hover:underline block"
                              >
                                View private withdrawal on BaseScan
                              </a>
                            )}
                          </div>
                        )}
                      </div>

                      {/* How withdrawal works */}
                      <div className="bg-[#f8f7f4] border border-gray-200 rounded-2xl p-5">
                        <h3 className="font-syne font-semibold text-sm text-gray-600 mb-3">How ZK withdrawal works</h3>
                        <div className="space-y-3 text-xs text-gray-500 font-inter leading-relaxed">
                          <div className="flex gap-3">
                            <span className="text-indigo-400 font-mono w-4 shrink-0">1.</span>
                            <span>The server loads the ZK circuit (2.5MB WASM) and proving key (17MB)</span>
                          </div>
                          <div className="flex gap-3">
                            <span className="text-indigo-400 font-mono w-4 shrink-0">2.</span>
                            <span>It reconstructs the Merkle tree from on-chain deposit events</span>
                          </div>
                          <div className="flex gap-3">
                            <span className="text-indigo-400 font-mono w-4 shrink-0">3.</span>
                            <span>It generates a Groth16 proof: &quot;I own a leaf in this tree&quot; without revealing which one</span>
                          </div>
                          <div className="flex gap-3">
                            <span className="text-indigo-400 font-mono w-4 shrink-0">4.</span>
                            <span>The proof is submitted via relay to the contract, which verifies it and sends USDC to your chosen address</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </section>

            {/* ── PAY AGENT SECTION ── */}
            <section
              data-section="pay"
              ref={paySectionRef}
              className="snap-section relative flex flex-col justify-center px-12 pt-[120px] pb-20 border-l border-r border-gray-200 mx-6"
            >
              <span className="section-number-el absolute top-1/2 -translate-y-1/2 -left-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>06</span>
              <span className="section-number-el absolute top-1/2 -translate-y-1/2 -right-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>06</span>

              <div className="relative z-10 max-w-[800px] mx-auto w-full space-y-6">
                <div>
                  <span className="inline-flex items-center gap-2 font-inter font-semibold text-xs uppercase tracking-[0.08em] px-[18px] py-1.5 rounded-full bg-lime-600 text-white mb-4">
                    x402 Private Payments
                  </span>
                  <h2 className="font-syne font-bold text-[32px] leading-tight tracking-[-1px] text-black mt-3">Private Agent Payment</h2>
                  <p className="font-inter text-sm text-gray-500 mt-2">
                    Pay AI agents via x402 without revealing what you bought. Your payment comes
                    from the privacy pool, not your wallet. Nobody can link it to you.
                  </p>
                </div>

                {!isConnected ? (
                  <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center space-y-4">
                    <p className="font-inter text-sm text-gray-500">
                      Connect your wallet to pay AI agents privately from the pool.
                    </p>
                    <div className="flex justify-center">
                      <ConnectButton />
                    </div>
                  </div>
                ) : (
                <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm space-y-5">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center text-xs text-indigo-500 font-bold">x</div>
                    <span className="font-syne font-semibold text-sm">x402 Private Payment</span>
                  </div>

                  <div>
                    <label className="font-inter font-medium text-xs text-gray-500 block mb-2">Agent / Service Provider Address</label>
                    <input
                      type="text"
                      value={withdrawAddress}
                      onChange={(e) => setWithdrawAddress(e.target.value)}
                      placeholder="0x... (agent's payment address)"
                      className="w-full bg-[#f8f7f4] border border-gray-200 rounded-xl px-4 py-3 text-sm font-mono placeholder:text-gray-400 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>

                  <div>
                    <label className="font-inter font-medium text-xs text-gray-500 block mb-2">Payment Amount (USDC)</label>
                    <input
                      type="text"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="0.50"
                      className="w-full bg-[#f8f7f4] border border-gray-200 rounded-xl px-4 py-3 text-sm font-mono placeholder:text-gray-400 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                    <p className="font-inter text-xs text-gray-400 mt-1">
                      Payment is sent from the privacy pool. Agent receives USDC with no link to your wallet.
                    </p>
                  </div>

                  <button
                    onClick={async () => {
                      if (!address) return;
                      setWithdrawStatus("proving");
                      setWithdrawError("");
                      setWithdrawTxHash("");
                      const startTime = Date.now();
                      try {
                        // Find a ZK-ready deposit to pay from (freshest vault
                        // state — the hook value could be a render behind)
                        const deposits = [...(getVaultDeposits(address) as StoredDeposit[])];
                        const deposit = deposits.find((d: { zkReady?: boolean; withdrawn?: boolean }) => d.zkReady && !d.withdrawn);
                        if (!deposit) {
                          setWithdrawError("No funds in privacy pool. Deposit USDC first.");
                          setWithdrawStatus("error");
                          return;
                        }

                        const recipient = withdrawAddress || address;

                        // Use the withdraw API (same mechanism, different framing)
                        const res = await fetch("/api/withdraw", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            nullifier: deposit.nullifier,
                            secret: deposit.secret,
                            value: deposit.value,
                            label: deposit.label,
                            commitment: deposit.commitment,
                            recipient,
                            amountAtomic: parseUnits(depositAmount, 6).toString(),
                          }),
                        });

                        const data = await res.json();
                        setProofTime(Date.now() - startTime);

                        if (!res.ok || data.error) {
                          setWithdrawError(data.error || "Payment failed");
                          setWithdrawStatus("error");
                          return;
                        }

                        setWithdrawTxHash(data.txHash);
                        deposit.withdrawn = true;
                        if (data.nextDeposit) {
                          deposits.push({
                            ...data.nextDeposit,
                            amount: (Number(data.nextDeposit.value) / 1e6).toString(),
                            asset: "USDC",
                            txHash: data.txHash,
                            timestamp: Date.now(),
                            zkReady: true,
                          });
                        }
                        saveDepositVault(deposits);
                        setWithdrawStatus("done");
                      } catch (err) {
                        setWithdrawError((err as Error).message?.slice(0, 300) || "Payment failed");
                        setWithdrawStatus("error");
                      }
                    }}
                    disabled={withdrawStatus === "proving" || !withdrawAddress || !depositAmount}
                    className="w-full py-3.5 bg-indigo-500 text-white font-inter font-semibold rounded-xl hover:bg-indigo-600 transition-all disabled:opacity-50"
                  >
                    {withdrawStatus === "proving" ? "Generating ZK Proof & Paying..." :
                     withdrawStatus === "done" ? `Paid Privately! (${(proofTime / 1000).toFixed(1)}s)` :
                     "Pay Agent Privately"}
                  </button>

                  {withdrawError && (
                    <p className="text-xs text-red-600 bg-red-50 rounded-xl p-3 break-all border border-red-200">{withdrawError}</p>
                  )}

                  {withdrawStatus === "done" && (
                    <div className="text-xs text-indigo-700 bg-indigo-50 rounded-xl p-4 space-y-2 border border-indigo-200">
                      <p className="font-medium">Private payment complete!</p>
                      <p className="text-gray-500">
                        The agent received USDC from the privacy pool. Your wallet address
                        does not appear anywhere in the payment. Zero-knowledge proof verified on-chain.
                      </p>
                      {withdrawTxHash && (
                        <a
                          href={`https://sepolia.basescan.org/tx/${withdrawTxHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-500 hover:underline block"
                        >
                          View on BaseScan (notice: no link to your wallet)
                        </a>
                      )}
                    </div>
                  )}
                </div>
                )}

                {/* How private x402 works */}
                <div className="bg-[#f8f7f4] border border-gray-200 rounded-2xl p-5">
                  <h3 className="font-syne font-semibold text-sm text-gray-600 mb-3">How private x402 payments work</h3>
                  <div className="space-y-3 text-xs text-gray-500 font-inter leading-relaxed">
                    <div className="flex gap-3">
                      <span className="text-indigo-400 font-mono w-4 shrink-0">1.</span>
                      <span>You pre-fund the privacy pool with USDC (Deposit tab). One deposit funds many subsequent x402 payments.</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="text-indigo-400 font-mono w-4 shrink-0">2.</span>
                      <span>When an AI agent sends a 402 payment request, you generate a ZK withdrawal proof.</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="text-indigo-400 font-mono w-4 shrink-0">3.</span>
                      <span>The proof verifies you have funds without revealing which deposit is yours.</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="text-indigo-400 font-mono w-4 shrink-0">4.</span>
                      <span>USDC is sent to the agent from the pool. No on-chain link to your wallet. The agent gets paid. You stay private.</span>
                    </div>
                  </div>

                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <h4 className="text-xs text-gray-600 font-inter font-medium mb-2">Why this matters</h4>
                    <p className="text-xs text-gray-400 font-inter leading-relaxed">
                      2.25M x402 transactions last month ($49.5M volume, 118K+ buyers). Every one reveals what service you
                      bought, how much you paid, and your wallet&apos;s entire history. Competitors see your
                      AI tool spending. Adversaries see your research queries. zBase breaks that link.
                    </p>
                  </div>
                </div>
              </div>
            </section>


            {/* ── INTEGRATE SECTION ── */}
            <section
              data-section="integrate"
              ref={integrateSectionRef}
              className="snap-section relative flex flex-col justify-center px-12 pt-[120px] pb-20 border-l border-r border-gray-200 mx-6"
            >
              <span className="section-number-el absolute top-1/2 -translate-y-1/2 -left-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>08</span>
              <span className="section-number-el absolute top-1/2 -translate-y-1/2 -right-6 font-syne font-bold text-xs text-gray-400 tracking-[0.1em]" style={{ writingMode: "vertical-rl" }}>08</span>

              <div className="relative z-10 max-w-[800px] mx-auto w-full space-y-6">
                <div>
                  <span className="inline-flex items-center gap-2 font-inter font-semibold text-xs uppercase tracking-[0.08em] px-[18px] py-1.5 rounded-full bg-indigo-500 text-white mb-4">
                    Developer SDK
                  </span>
                  <h2 className="font-syne font-bold text-[32px] leading-tight tracking-[-1px] text-black mt-3">Integrate zBase</h2>
                  <p className="font-inter text-sm text-gray-500 mt-2">
                    Add private payments to any agent, dApp, or x402 service in minutes.
                  </p>
                </div>

                {/* SDK */}
                <div className="bg-white border border-indigo-200 rounded-2xl p-6 shadow-sm">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="font-syne font-semibold text-base text-indigo-500">Option 1: SDK</h3>
                    <span className="font-inter text-[10px] uppercase tracking-wider text-green-800 bg-green-100 border border-green-300 px-2 py-0.5 rounded-full">Live on npm</span>
                  </div>
                  <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 mb-4">
                    <p className="font-inter font-semibold text-xs text-indigo-700 mb-1">When to use</p>
                    <p className="font-inter text-xs text-indigo-600 leading-relaxed">
                      You&apos;re building an AI agent, dApp, or backend service that needs private payments.
                      The SDK handles deposit, private settle, and stealth payout in a few lines of TypeScript.
                    </p>
                    <pre className="mt-3 bg-indigo-900 text-indigo-100 rounded-lg p-3 text-[11px] overflow-x-auto"><code>npm install @zbase-protocol/core</code></pre>
                  </div>
                </div>

                {/* x402 Facilitator */}
                <div className="bg-white border border-indigo-200 rounded-2xl p-6 shadow-sm">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="font-syne font-semibold text-base text-indigo-500">Option 2: x402 Facilitator</h3>
                    <span className="font-inter text-[10px] uppercase tracking-wider text-green-800 bg-green-100 border border-green-300 px-2 py-0.5 rounded-full">Live</span>
                  </div>
                  <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 mb-4">
                    <p className="font-inter font-semibold text-xs text-indigo-700 mb-1">When to use</p>
                    <p className="font-inter text-xs text-indigo-600 leading-relaxed">
                      You already have an x402 agent (AgentCash, Claude Code, Cursor, or any x402 client).
                      Just change your facilitator URL from Coinbase CDP to zBase. Zero code changes on the agent side.
                      Like replacing Stripe with PayPal: same checkout flow, different processor, now with privacy.
                    </p>
                  </div>
                </div>

                {/* Direct API */}
                <div className="bg-white border border-lime-200 rounded-2xl p-6 shadow-sm">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="font-syne font-semibold text-base text-lime-600">Option 3: Direct API</h3>
                    <span className="font-inter text-[10px] uppercase tracking-wider text-green-800 bg-green-100 border border-green-300 px-2 py-0.5 rounded-full">Live</span>
                  </div>
                  <div className="bg-lime-50 border border-lime-100 rounded-xl p-4 mb-4">
                    <p className="font-inter font-semibold text-xs text-lime-700 mb-1">When to use</p>
                    <p className="font-inter text-xs text-lime-600 leading-relaxed">
                      You&apos;re building a custom integration that doesn&apos;t use x402. You want direct access to ZK proof generation and relay submission.
                      The facilitator endpoints call these internally. More control, less abstraction. One API call = one private payment.
                    </p>
                  </div>
                </div>

                {/* OpenClaw / Any AI Agent */}
                <div className="bg-white border border-orange-200 rounded-2xl p-6 shadow-sm">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="font-syne font-semibold text-base text-orange-600">Option 4: Any AI Agent</h3>
                    <span className="font-inter text-[10px] uppercase tracking-wider text-green-800 bg-green-100 border border-green-300 px-2 py-0.5 rounded-full">Live</span>
                  </div>
                  <div className="bg-orange-50 border border-orange-100 rounded-xl p-4 mb-4">
                    <p className="font-inter font-semibold text-xs text-orange-700 mb-1">When to use</p>
                    <p className="font-inter text-xs text-orange-600 leading-relaxed">
                      You want any AI agent (Claude, ChatGPT, OpenClaw, Cursor) to make private payments.
                      Just paste the prompt below into your agent. No SDK, no install, no code changes.
                      The agent calls two API endpoints and the payment happens privately.
                    </p>
                  </div>

                </div>

                {/* Get started note */}
                <div className="bg-[#f3e7c8] border border-[#e2d09a] rounded-2xl p-5 text-center">
                  <p className="font-inter text-[13px] text-[#6b5417]">
                    <span className="font-semibold">x402 provider? Get paid privately.</span> Register a stealth
                    meta-address, advertise it as your <code className="bg-[#e2d09a]/40 px-1 rounded text-[11px]">payTo</code>,
                    and every payment lands at a fresh unlinkable address.{" "}
                    <a href="https://docs.zbase.app" target="_blank" rel="noopener noreferrer" className="font-semibold underline decoration-[#e2d09a] hover:decoration-[#6b5417]">
                      Seller quickstart →
                    </a>{" "}
                    · Questions? DM{" "}
                    <a href="https://x.com/zbase__" target="_blank" rel="noopener noreferrer" className="font-semibold underline decoration-[#e2d09a] hover:decoration-[#6b5417]">
                      @zbase__
                    </a>
                  </p>
                </div>

                {/* Contracts (chain-aware) */}
                <div className="bg-[#f8f7f4] border border-gray-200 rounded-2xl p-5">
                  <h3 className="font-syne font-semibold text-sm text-gray-600 mb-3">{isSvm ? "Program (Solana Devnet)" : "Contracts (Base Sepolia)"}</h3>
                  <div className="space-y-2 text-xs font-mono font-inter">
                    <div className="flex justify-between">
                      <span className="text-gray-500">{isSvm ? "Program" : "Entrypoint"}</span>
                      <span className="text-gray-400">{chain.entrypointAddress}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">{isSvm ? "Pool PDA" : "USDC Pool"}</span>
                      <span className="text-gray-400">{chain.poolAddress}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">USDC Mint</span>
                      <span className="text-gray-400">{chain.usdcAddress}</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>
        </>

        {/* ── FOOTER ── */}
        <footer className="flex items-center justify-between px-12 py-6 border-t border-gray-200 bg-[#f8f7f4]">
          <span className="font-syne font-extrabold text-base text-black tracking-[-0.3px]">zBase</span>
          <span className="font-inter text-[13px] text-gray-500 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-500 inline-block" />
            Base Sepolia
          </span>
          <span className="font-inter text-[12px] text-gray-400">Built for Base Batches 2026</span>
        </footer>
      </main>
    </>
  );
}
