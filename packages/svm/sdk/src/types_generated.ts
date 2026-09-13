/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/zx402_privacy_pool.json`.
 */
export type Zx402PrivacyPool = {
  "address": "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM",
  "metadata": {
    "name": "zx402PrivacyPool",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "deposit",
      "docs": [
        "Deposit USDC into the privacy pool.",
        "",
        "`precommitment` = Poseidon(2)([nullifier, secret]) is computed off-chain",
        "by the depositor. The contract derives `label = keccak256(scope, nonce)",
        "% SNARK_FIELD` on-chain (so a depositor cannot lie about which label",
        "their deposit gets), computes `commitment = Poseidon(3)([value, label,",
        "precommitment])`, and inserts the commitment into the LeanIMT."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "depositRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "poolState"
              },
              {
                "kind": "account",
                "path": "pool_state.deposit_count",
                "account": "poolState"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "depositorTokenAccount",
          "writable": true
        },
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "precommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Initialize the privacy pool with owner, postman, and USDC mint."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "poolState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "poolState"
              }
            ]
          }
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "postman"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "vettingFeeBps",
          "type": "u64"
        },
        {
          "name": "maxRelayFeeBps",
          "type": "u64"
        },
        {
          "name": "minimumDeposit",
          "type": "u64"
        }
      ]
    },
    {
      "name": "redeemFromKamino",
      "docs": [
        "Redeem USDC from Kamino lending. (Owner-only; unchanged in V1.)"
      ],
      "discriminator": [
        112,
        116,
        195,
        132,
        156,
        167,
        246,
        193
      ],
      "accounts": [
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "ctokenAccount",
          "writable": true
        },
        {
          "name": "kaminoReserve",
          "writable": true
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "kaminoMarket"
        },
        {
          "name": "kaminoMarketAuthority"
        },
        {
          "name": "kaminoProgram"
        },
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "collateralAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "registerAgent",
      "docs": [
        "Register an AI agent with identity and permissions. (Unchanged in V1.)"
      ],
      "discriminator": [
        135,
        157,
        66,
        195,
        2,
        113,
        175,
        30
      ],
      "accounts": [
        {
          "name": "agentRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "hotKey"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "hotKey"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "maxSpendPerTx",
          "type": "u64"
        },
        {
          "name": "maxSpendPerDay",
          "type": "u64"
        }
      ]
    },
    {
      "name": "relayWithdrawal",
      "docs": [
        "Relay a withdrawal using a Groth16 ZK proof.",
        "",
        "The relayer (postman) supplies:",
        "* `proof_a`, `proof_b`, `proof_c`: groth16-solana-formatted proof",
        "bytes (proof_a is already negated and endian-swapped per the",
        "groth16-solana convention; the SDK does this off-chain).",
        "* `public_inputs`: the 8 publicSignals from snarkjs, in the order",
        "[newCommitmentHash, existingNullifierHash, withdrawnValue,",
        "stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context].",
        "* `withdrawal_data`: the serialized recipient/feeRecipient/relayFeeBps",
        "blob; only used to recompute `context` for binding.",
        "",
        "Note on chain compatibility: `context` on Solana is",
        "`keccak256(pool_pda || withdrawal_data || scope) % SNARK_FIELD`,",
        "which differs from the EVM `keccak256(abi.encode(Withdrawal{processooor,",
        "data}, scope))`. A proof generated for one chain therefore cannot",
        "settle on the other — by design — even though the underlying circuit",
        "and trusted setup are shared. The SDK builds the appropriate `context`",
        "per chain; depositors don't see this.",
        "",
        "The instruction enforces:",
        "1. State root must match a known historical root.",
        "2. ASP root must equal `pool.asp_root` (current). This is what makes",
        "this a *compliant* privacy pool, not a mixer.",
        "3. `context` must equal `keccak256(processooor || data || scope)",
        "% SNARK_FIELD`. Binds the proof to this exact recipient + relay",
        "fee, so a malicious relayer cannot rewrite the destination.",
        "4. `withdrawnValue` from the public inputs must match the on-chain",
        "`withdrawn_value` argument.",
        "5. Nullifier must be unspent (PDA seed enforces uniqueness).",
        "6. Groth16 proof must verify against the embedded `VERIFYING_KEY`."
      ],
      "discriminator": [
        82,
        107,
        116,
        206,
        198,
        253,
        16,
        16
      ],
      "accounts": [
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "nullifierRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  117,
                  108,
                  108,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "poolState"
              },
              {
                "kind": "arg",
                "path": "nullifierHash"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "recipientTokenAccount",
          "writable": true
        },
        {
          "name": "relayerTokenAccount",
          "writable": true
        },
        {
          "name": "relayer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nullifierHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "recipient",
          "type": "pubkey"
        },
        {
          "name": "withdrawnValue",
          "type": "u64"
        },
        {
          "name": "relayFeeBps",
          "type": "u64"
        },
        {
          "name": "withdrawalData",
          "type": "bytes"
        },
        {
          "name": "proofA",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "proofB",
          "type": {
            "array": [
              "u8",
              128
            ]
          }
        },
        {
          "name": "proofC",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "publicInputs",
          "type": {
            "array": [
              {
                "array": [
                  "u8",
                  32
                ]
              },
              8
            ]
          }
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Pause/unpause the pool (owner only)."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "supplyToKamino",
      "docs": [
        "Supply vault USDC to Kamino lending for yield. (Owner-only; unchanged",
        "in V1 — we kept the legacy CPI shape so devnet integration tests still",
        "link.)"
      ],
      "discriminator": [
        197,
        97,
        160,
        132,
        21,
        74,
        11,
        35
      ],
      "accounts": [
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "ctokenAccount",
          "writable": true
        },
        {
          "name": "kaminoReserve",
          "writable": true
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "kaminoMarket"
        },
        {
          "name": "kaminoMarketAuthority"
        },
        {
          "name": "kaminoProgram"
        },
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateAspRoot",
      "docs": [
        "Update the ASP (Association Set Provider) root. Postman-only."
      ],
      "discriminator": [
        153,
        165,
        251,
        139,
        40,
        73,
        41,
        184
      ],
      "accounts": [
        {
          "name": "poolState",
          "writable": true
        },
        {
          "name": "postman",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "ipfsCid",
          "type": "string"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "agentRecord",
      "discriminator": [
        4,
        201,
        129,
        70,
        197,
        134,
        47,
        169
      ]
    },
    {
      "name": "depositRecord",
      "discriminator": [
        83,
        232,
        10,
        31,
        251,
        49,
        189,
        167
      ]
    },
    {
      "name": "nullifierRecord",
      "discriminator": [
        56,
        18,
        57,
        175,
        69,
        202,
        189,
        70
      ]
    },
    {
      "name": "poolState",
      "discriminator": [
        247,
        237,
        227,
        245,
        215,
        195,
        222,
        70
      ]
    }
  ],
  "events": [
    {
      "name": "aspRootUpdated",
      "discriminator": [
        4,
        104,
        47,
        28,
        43,
        249,
        229,
        231
      ]
    },
    {
      "name": "depositEvent",
      "discriminator": [
        120,
        248,
        61,
        83,
        31,
        142,
        107,
        144
      ]
    },
    {
      "name": "kaminoRedeemEvent",
      "discriminator": [
        220,
        148,
        202,
        253,
        12,
        49,
        42,
        13
      ]
    },
    {
      "name": "kaminoSupplyEvent",
      "discriminator": [
        223,
        5,
        221,
        12,
        229,
        187,
        0,
        238
      ]
    },
    {
      "name": "withdrawalEvent",
      "discriminator": [
        161,
        53,
        185,
        18,
        98,
        254,
        54,
        165
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "poolPaused",
      "msg": "Pool is paused"
    },
    {
      "code": 6001,
      "name": "belowMinimumDeposit",
      "msg": "Deposit below minimum"
    },
    {
      "code": 6002,
      "name": "nullifierAlreadySpent",
      "msg": "Nullifier already spent"
    },
    {
      "code": 6003,
      "name": "relayFeeTooHigh",
      "msg": "Relay fee exceeds maximum"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6005,
      "name": "invalidProof",
      "msg": "Invalid proof"
    },
    {
      "code": 6006,
      "name": "spendLimitExceeded",
      "msg": "Agent spend limit exceeded"
    },
    {
      "code": 6007,
      "name": "unknownStateRoot",
      "msg": "State root not recognized by pool"
    },
    {
      "code": 6008,
      "name": "incorrectAspRoot",
      "msg": "ASP root in proof does not match pool ASP root"
    },
    {
      "code": 6009,
      "name": "contextMismatch",
      "msg": "Withdrawal context hash does not match"
    },
    {
      "code": 6010,
      "name": "invalidWithdrawalAmount",
      "msg": "Withdrawn amount is invalid"
    },
    {
      "code": 6011,
      "name": "invalidTreeDepth",
      "msg": "Tree depth exceeds maximum"
    }
  ],
  "types": [
    {
      "name": "agentRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "hotKey",
            "type": "pubkey"
          },
          {
            "name": "maxSpendPerTx",
            "type": "u64"
          },
          {
            "name": "maxSpendPerDay",
            "type": "u64"
          },
          {
            "name": "totalSpent",
            "type": "u64"
          },
          {
            "name": "dailySpent",
            "type": "u64"
          },
          {
            "name": "txCount",
            "type": "u64"
          },
          {
            "name": "lastResetDay",
            "type": "i64"
          },
          {
            "name": "registeredAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "aspRootUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ipfsCid",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "depositEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "label",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "value",
            "type": "u64"
          },
          {
            "name": "index",
            "type": "u64"
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "newDepth",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "depositRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "precommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "label",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "index",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "kaminoRedeemEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "collateralAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "kaminoSupplyEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "leanImtFrontier",
      "docs": [
        "LeanIMT side-nodes (\"frontier\") storing the right-most node at every depth.",
        "On insert, walk up from depth 0:",
        "- if the leaf-index bit at this level is 0: this node has no right",
        "sibling yet; record it in `side_nodes[level]` and stop hashing",
        "(its parent equals itself).",
        "- if the bit is 1: the left sibling lives in `side_nodes[level]`; the",
        "parent is poseidon2(side_nodes[level], current_node), then continue.",
        "The final \"current_node\" (after walking through all set bits) is the root.",
        "",
        "`current_depth` is the smallest depth such that `1 << current_depth >= size`.",
        "It grows monotonically: when a deposit_count crosses 1, 2, 4, 8, ...,",
        "the depth bumps by one. This matches @zk-kit/lean-imt's behavior."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sideNodes",
            "docs": [
              "One stored side-node per level. Index = level (0 = leaf-row)."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                32
              ]
            }
          },
          {
            "name": "size",
            "docs": [
              "Number of leaves inserted so far. Doubles as the next leaf index."
            ],
            "type": "u64"
          },
          {
            "name": "currentDepth",
            "docs": [
              "`ceil(log2(max(size, 1)))`. Required as a public input in the circuit."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "nullifierRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "nullifierHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "spent",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "poolState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "postman",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "scope",
            "docs": [
              "32-byte BE field element. keccak256(pool_id || token_mint) % SNARK_FIELD."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "treeRoot",
            "docs": [
              "Latest LeanIMT root."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "aspRoot",
            "docs": [
              "Latest ASP root (set by postman)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "depositCount",
            "docs": [
              "Number of leaves inserted."
            ],
            "type": "u64"
          },
          {
            "name": "vettingFeeBps",
            "type": "u64"
          },
          {
            "name": "maxRelayFeeBps",
            "type": "u64"
          },
          {
            "name": "minimumDeposit",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "frontier",
            "docs": [
              "LeanIMT side-nodes + size + depth. Recomputes the root on demand."
            ],
            "type": {
              "defined": {
                "name": "leanImtFrontier"
              }
            }
          },
          {
            "name": "knownStateRoots",
            "docs": [
              "Ring buffer of recent state roots. A relayer can submit a proof",
              "against any of these — required because deposits land between proof",
              "generation and proof submission."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                32
              ]
            }
          },
          {
            "name": "knownStateRootsIdx",
            "docs": [
              "Ring buffer write head."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "withdrawalEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "nullifierHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "value",
            "type": "u64"
          },
          {
            "name": "relayFee",
            "type": "u64"
          },
          {
            "name": "newCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "newRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    }
  ]
};
