"use client";

import { useState, useRef, useEffect } from "react";
import { useChain, type ChainId, CHAINS } from "@/lib/chain-context";

export function ChainSelector() {
  const { chainId, setChainId, chain } = useChain();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      {/* Selected chain button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "7px 14px",
          borderRadius: "10px",
          border: "1px solid #e5e7eb",
          background: "white",
          color: "#111",
          cursor: "pointer",
          fontSize: "13px",
          fontWeight: 500,
          transition: "all 0.15s",
        }}
      >
        <span style={{ fontSize: "15px" }}>{chain.type === "evm" ? "⬡" : "◎"}</span>
        {chain.name}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          style={{
            marginLeft: "2px",
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        >
          <path d="M3 4.5L6 7.5L9 4.5" stroke="#888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: "200px",
            background: "white",
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 100,
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "6px" }}>
            {(Object.keys(CHAINS) as ChainId[]).map((id) => {
              const c = CHAINS[id];
              const isActive = chainId === id;

              return (
                <button
                  key={id}
                  onClick={() => {
                    setChainId(id);
                    setIsOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "none",
                    background: isActive ? "#f0f0ff" : "transparent",
                    color: "#111",
                    cursor: "pointer",
                    fontSize: "14px",
                    fontWeight: isActive ? 600 : 400,
                    textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) (e.target as HTMLElement).style.background = "#f8f8f8";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) (e.target as HTMLElement).style.background = "transparent";
                  }}
                >
                  <span style={{ fontSize: "18px", width: "24px", textAlign: "center" }}>
                    {c.type === "evm" ? "⬡" : "◎"}
                  </span>
                  <div>
                    <div style={{ lineHeight: "18px" }}>{c.name}</div>
                    <div style={{ fontSize: "11px", color: "#999", marginTop: "2px" }}>
                      {c.type === "evm" ? "EVM" : "Solana"} · {c.id.includes("devnet") || c.id.includes("sepolia") ? "Testnet" : "Mainnet"}
                    </div>
                  </div>
                  {isActive && (
                    <span style={{ marginLeft: "auto", color: "#6366f1", fontSize: "14px" }}>✓</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
