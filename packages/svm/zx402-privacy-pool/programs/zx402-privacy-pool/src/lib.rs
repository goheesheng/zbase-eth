use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

mod crypto;
mod verifying_key;

use crypto::{
    compute_context, compute_label, compute_scope, encode_withdrawal_data, fe_from_u64, poseidon3,
    Fe, LeanImtFrontier, MAX_TREE_DEPTH,
};
use groth16_solana::groth16::Groth16Verifier;
use verifying_key::{N_PUBLIC, VERIFYING_KEY};

declare_id!("7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM");

#[program]
pub mod zx402_privacy_pool {
    use super::*;

    /// Initialize the privacy pool with owner, postman, and USDC mint.
    pub fn initialize(
        ctx: Context<InitializePool>,
        vetting_fee_bps: u64,
        max_relay_fee_bps: u64,
        minimum_deposit: u64,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool_state.key();
        let mint_key = ctx.accounts.token_mint.key();
        let scope = compute_scope(&pool_key, &mint_key);
        let bump = ctx.bumps.pool_state;
        let vault_bump = ctx.bumps.vault;

        let pool = &mut ctx.accounts.pool_state;
        pool.owner = ctx.accounts.owner.key();
        pool.postman = ctx.accounts.postman.key();
        pool.token_mint = mint_key;
        pool.vault = ctx.accounts.vault.key();
        pool.vetting_fee_bps = vetting_fee_bps;
        pool.max_relay_fee_bps = max_relay_fee_bps;
        pool.minimum_deposit = minimum_deposit;
        pool.deposit_count = 0;
        pool.tree_root = [0u8; 32];
        pool.asp_root = [0u8; 32];
        pool.scope = scope;
        pool.bump = bump;
        pool.vault_bump = vault_bump;
        pool.paused = false;
        pool.frontier = LeanImtFrontier::empty();

        // Track every state root we've ever set so a relayer can submit a
        // proof against a slightly-stale root without it being rejected
        // mid-block. Same idea as the EVM `IS_KNOWN_STATE_ROOT` mapping.
        pool.known_state_roots = [[0u8; 32]; HISTORICAL_ROOTS];
        pool.known_state_roots_idx = 0;

        msg!(
            "zx402 privacy pool initialized. scope={:?}",
            &pool.scope[..8]
        );
        Ok(())
    }

    /// Deposit USDC into the privacy pool.
    ///
    /// `precommitment` = Poseidon(2)([nullifier, secret]) is computed off-chain
    /// by the depositor. The contract derives `label = keccak256(scope, nonce)
    /// % SNARK_FIELD` on-chain (so a depositor cannot lie about which label
    /// their deposit gets), computes `commitment = Poseidon(3)([value, label,
    /// precommitment])`, and inserts the commitment into the LeanIMT.
    pub fn deposit(ctx: Context<Deposit>, precommitment: [u8; 32], amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;
        require!(!pool.paused, ZX402Error::PoolPaused);
        require!(
            amount >= pool.minimum_deposit,
            ZX402Error::BelowMinimumDeposit
        );

        // Vetting fee retained in vault (kept consistent with upstream behavior;
        // a future ix can sweep it). `net_amount` is what backs the commitment
        // value the user can later withdraw.
        let fee = amount
            .checked_mul(pool.vetting_fee_bps)
            .ok_or(ZX402Error::InvalidProof)?
            / 10_000;
        let net_amount = amount.checked_sub(fee).ok_or(ZX402Error::InvalidProof)?;

        // Pull USDC from depositor into vault.
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        // Derive label and commitment ON-CHAIN.
        let nonce = pool.deposit_count;
        let label = compute_label(&pool.scope, nonce);
        let value_fe = fe_from_u64(net_amount);
        let commitment = poseidon3(&value_fe, &label, &precommitment)?;

        // Insert into the LeanIMT and remember the new root in the
        // historical-roots ring buffer so relayers can use it.
        let new_root = pool.frontier.insert(commitment)?;
        pool.tree_root = new_root;
        let idx = pool.known_state_roots_idx as usize;
        pool.known_state_roots[idx] = new_root;
        pool.known_state_roots_idx = ((idx + 1) % HISTORICAL_ROOTS) as u8;

        // Record deposit (for audit + tooling).
        let deposit_record = &mut ctx.accounts.deposit_record;
        deposit_record.pool = pool.key();
        deposit_record.depositor = ctx.accounts.depositor.key();
        deposit_record.precommitment = precommitment;
        deposit_record.commitment = commitment;
        deposit_record.label = label;
        deposit_record.amount = net_amount;
        deposit_record.index = nonce;
        deposit_record.timestamp = Clock::get()?.unix_timestamp;
        deposit_record.bump = ctx.bumps.deposit_record;

        pool.deposit_count = pool.deposit_count.checked_add(1).unwrap();

        emit!(DepositEvent {
            pool: pool.key(),
            depositor: ctx.accounts.depositor.key(),
            commitment,
            label,
            value: net_amount,
            index: nonce,
            new_root,
            new_depth: pool.frontier.current_depth,
        });

        Ok(())
    }

    /// Relay a withdrawal using a Groth16 ZK proof.
    ///
    /// The relayer (postman) supplies:
    ///   * `proof_a`, `proof_b`, `proof_c`: groth16-solana-formatted proof
    ///     bytes (proof_a is already negated and endian-swapped per the
    ///     groth16-solana convention; the SDK does this off-chain).
    ///   * `public_inputs`: the 8 publicSignals from snarkjs, in the order
    ///     [newCommitmentHash, existingNullifierHash, withdrawnValue,
    ///      stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context].
    ///   * `withdrawal_data`: the serialized recipient/feeRecipient/relayFeeBps
    ///     blob; only used to recompute `context` for binding.
    ///
    /// Note on chain compatibility: `context` on Solana is
    /// `keccak256(pool_pda || withdrawal_data || scope) % SNARK_FIELD`,
    /// which differs from the EVM `keccak256(abi.encode(Withdrawal{processooor,
    /// data}, scope))`. A proof generated for one chain therefore cannot
    /// settle on the other — by design — even though the underlying circuit
    /// and trusted setup are shared. The SDK builds the appropriate `context`
    /// per chain; depositors don't see this.
    ///
    /// The instruction enforces:
    ///   1. State root must match a known historical root.
    ///   2. ASP root must equal `pool.asp_root` (current). This is what makes
    ///      this a *compliant* privacy pool, not a mixer.
    ///   3. `context` must equal `keccak256(processooor || data || scope)
    ///      % SNARK_FIELD`. Binds the proof to this exact recipient + relay
    ///      fee, so a malicious relayer cannot rewrite the destination.
    ///   4. `withdrawnValue` from the public inputs must match the on-chain
    ///      `withdrawn_value` argument.
    ///   5. Nullifier must be unspent (PDA seed enforces uniqueness).
    ///   6. Groth16 proof must verify against the embedded `VERIFYING_KEY`.
    pub fn relay_withdrawal(
        ctx: Context<RelayWithdrawal>,
        nullifier_hash: [u8; 32],
        recipient: Pubkey,
        withdrawn_value: u64,
        relay_fee_bps: u64,
        withdrawal_data: Vec<u8>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; N_PUBLIC],
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;
        require!(!pool.paused, ZX402Error::PoolPaused);
        require!(
            relay_fee_bps <= pool.max_relay_fee_bps,
            ZX402Error::RelayFeeTooHigh
        );

        // (5) nullifier uniqueness — the PDA seed is the nullifier hash, so a
        // double-spend attempt fails at account init. We still mark the record
        // explicitly so accounts list nicely.
        let nullifier_record = &mut ctx.accounts.nullifier_record;
        require!(!nullifier_record.spent, ZX402Error::NullifierAlreadySpent);

        // Public-input layout (matches packages/circuits/circuits/withdraw.circom):
        //   [0] newCommitmentHash       (output)
        //   [1] existingNullifierHash   (output)
        //   [2] withdrawnValue
        //   [3] stateRoot
        //   [4] stateTreeDepth
        //   [5] ASPRoot
        //   [6] ASPTreeDepth
        //   [7] context
        let pi_existing_nullifier_hash = &public_inputs[1];
        let pi_withdrawn_value = &public_inputs[2];
        let pi_state_root = &public_inputs[3];
        let pi_state_depth = &public_inputs[4];
        let pi_asp_root = &public_inputs[5];
        let pi_asp_depth = &public_inputs[6];
        let pi_context = &public_inputs[7];

        // (Sanity) the proof's nullifier hash must equal the nullifier the
        // relayer is creating an account for. Stops a relayer from racing two
        // different nullifiers through the same PDA seed.
        require!(
            *pi_existing_nullifier_hash == nullifier_hash,
            ZX402Error::InvalidProof
        );

        // (4) withdrawnValue cross-check.
        require!(
            *pi_withdrawn_value == fe_from_u64(withdrawn_value),
            ZX402Error::InvalidWithdrawalAmount
        );

        // (1) state root must be one we've seen.
        let mut state_root_known = false;
        for r in pool.known_state_roots.iter() {
            if r == pi_state_root {
                state_root_known = true;
                break;
            }
        }
        require!(state_root_known, ZX402Error::UnknownStateRoot);

        // Tree-depth sanity. Both depths are field-encoded u8 values that must
        // (a) have no high bytes set and (b) fit within MAX_TREE_DEPTH. The
        // circuit already enforces inclusion against the depth, so we just
        // need to keep an attacker from supplying garbage bytes.
        let depth_in_range = |fe: &Fe| {
            // High 31 bytes must be zero, low byte must be a sane depth.
            fe[..31].iter().all(|b| *b == 0) && (fe[31] as usize) <= MAX_TREE_DEPTH
        };
        require!(depth_in_range(pi_state_depth), ZX402Error::InvalidTreeDepth);
        require!(depth_in_range(pi_asp_depth), ZX402Error::InvalidTreeDepth);
        // The state-tree depth recorded in the proof must be <= the depth our
        // frontier has reached. (Strictly less is allowed — a stale-but-known
        // state root may have been smaller.)
        require!(
            (pi_state_depth[31] as u8) <= pool.frontier.current_depth,
            ZX402Error::InvalidTreeDepth
        );

        // (2) ASP root must match the current pool ASP root.
        require!(*pi_asp_root == pool.asp_root, ZX402Error::IncorrectAspRoot);

        // (3) context binds the ACTUAL recipient + fee + relayer + scope. The
        // caller also sends `withdrawal_data` for backwards-compatible IDL
        // shape, but those bytes are not trusted: they must exactly equal the
        // canonical encoding of the instruction accounts/arguments. Without
        // this equality check a malicious relayer could preserve proof-bound
        // bytes while changing `recipient` or `relay_fee_bps` and redirect the
        // real token transfer.
        let canonical_withdrawal_data =
            encode_withdrawal_data(&recipient, relay_fee_bps, &ctx.accounts.relayer.key());
        require!(
            withdrawal_data.as_slice() == canonical_withdrawal_data,
            ZX402Error::WithdrawalDataMismatch
        );
        let expected_context =
            compute_context(&pool.key(), &canonical_withdrawal_data, &pool.scope);
        require!(*pi_context == expected_context, ZX402Error::ContextMismatch);

        // (6) Groth16 verification.
        let mut verifier = Groth16Verifier::<N_PUBLIC>::new(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
            &VERIFYING_KEY,
        )
        .map_err(|_| error!(ZX402Error::InvalidProof))?;
        verifier
            .verify()
            .map_err(|_| error!(ZX402Error::InvalidProof))?;

        // Mark nullifier spent.
        nullifier_record.spent = true;
        nullifier_record.nullifier_hash = nullifier_hash;
        nullifier_record.pool = pool.key();
        nullifier_record.bump = ctx.bumps.nullifier_record;

        // Money movement.
        let pool_key = pool.key();
        let vault_bump = pool.vault_bump;
        let seeds = &[b"vault" as &[u8], pool_key.as_ref(), &[vault_bump]];
        let signer_seeds = &[&seeds[..]];

        let relay_fee = withdrawn_value
            .checked_mul(relay_fee_bps)
            .ok_or(ZX402Error::InvalidProof)?
            / 10_000;
        let recipient_amount = withdrawn_value
            .checked_sub(relay_fee)
            .ok_or(ZX402Error::InvalidWithdrawalAmount)?;

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi, recipient_amount)?;

        if relay_fee > 0 {
            let cpi_fee = CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.relayer_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(cpi_fee, relay_fee)?;
        }

        // The change commitment (publicSignals[0]) becomes a new leaf in the
        // state tree so any remaining balance stays in the privacy set.
        let new_commitment = public_inputs[0];
        let new_root = pool.frontier.insert(new_commitment)?;
        pool.tree_root = new_root;
        let idx = pool.known_state_roots_idx as usize;
        pool.known_state_roots[idx] = new_root;
        pool.known_state_roots_idx = ((idx + 1) % HISTORICAL_ROOTS) as u8;

        emit!(WithdrawalEvent {
            pool: pool.key(),
            recipient,
            nullifier_hash,
            value: recipient_amount,
            relay_fee,
            new_commitment,
            new_root,
        });

        Ok(())
    }

    /// Update the ASP (Association Set Provider) root. Postman-only.
    pub fn update_asp_root(
        ctx: Context<UpdateAspRoot>,
        new_root: [u8; 32],
        ipfs_cid: String,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;
        require!(
            ctx.accounts.postman.key() == pool.postman,
            ZX402Error::Unauthorized
        );

        pool.asp_root = new_root;

        emit!(AspRootUpdated {
            pool: pool.key(),
            new_root,
            ipfs_cid,
        });
        Ok(())
    }

    /// Register an AI agent with identity and permissions. (Unchanged in V1.)
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        max_spend_per_tx: u64,
        max_spend_per_day: u64,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent_record;
        agent.owner = ctx.accounts.owner.key();
        agent.name = name;
        agent.hot_key = ctx.accounts.hot_key.key();
        agent.max_spend_per_tx = max_spend_per_tx;
        agent.max_spend_per_day = max_spend_per_day;
        agent.total_spent = 0;
        agent.daily_spent = 0;
        agent.tx_count = 0;
        agent.last_reset_day = Clock::get()?.unix_timestamp / 86_400;
        agent.registered_at = Clock::get()?.unix_timestamp;
        agent.bump = ctx.bumps.agent_record;
        Ok(())
    }

    /// Pause/unpause the pool (owner only).
    pub fn set_paused(ctx: Context<AdminAction>, paused: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool_state;
        require!(
            ctx.accounts.authority.key() == pool.owner,
            ZX402Error::Unauthorized
        );
        pool.paused = paused;
        Ok(())
    }
}

// --- Constants ---

/// Number of historical state roots kept per pool. A relayer that built its
/// proof off a slightly stale state root (e.g. another deposit landed between
/// proof generation and submission) can still settle as long as their root
/// falls within this window. 32 ≈ a few seconds at Solana block times.
pub const HISTORICAL_ROOTS: usize = 32;

// --- Account contexts ---

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [b"pool", token_mint.key().as_ref()],
        bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        init,
        payer = owner,
        token::mint = token_mint,
        token::authority = vault,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: postman address for ASP root updates
    pub postman: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        init,
        payer = depositor,
        space = 8 + DepositRecord::INIT_SPACE,
        seeds = [b"deposit", pool_state.key().as_ref(), &pool_state.deposit_count.to_le_bytes()],
        bump
    )]
    pub deposit_record: Box<Account<'info, DepositRecord>>,

    // B5 (audit-sweep-2026-06-17): the deposit destination MUST be the pool's
    // own vault PDA. Pre-fix this was a loose `mut` TokenAccount and the deposit
    // transfer authority is the `depositor` (not a PDA-signed CPI), so a
    // depositor could send USDC to an account THEY control while still minting a
    // valid commitment into the tree — creating commitments unbacked by vault
    // funds and letting later honest withdrawals drain the real vault below the
    // sum of legitimate deposits. Binding to `pool_state.vault` enforces
    // solvency: a commitment can only be minted by funding the real vault.
    #[account(
        mut,
        address = pool_state.vault @ ZX402Error::InvalidVault
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub depositor_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nullifier_hash: [u8; 32], recipient: Pubkey)]
pub struct RelayWithdrawal<'info> {
    #[account(mut)]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        init,
        payer = relayer,
        space = 8 + NullifierRecord::INIT_SPACE,
        seeds = [b"nullifier", pool_state.key().as_ref(), &nullifier_hash],
        bump
    )]
    pub nullifier_record: Box<Account<'info, NullifierRecord>>,

    // B5 (audit-sweep-2026-06-17): the vault MUST be the pool's own vault PDA.
    // Pre-fix this was a loose `mut` TokenAccount, so a relayer could pass any
    // token account as `vault` (the `invoke_signed` vault-seed authority would
    // still only validate for the real PDA, so a foreign vault CPI fails — but
    // binding it here is the explicit, defense-in-depth gate and makes the
    // failure mode a clear constraint error instead of a CPI auth error).
    #[account(
        mut,
        address = pool_state.vault @ ZX402Error::InvalidVault
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    // B4 (audit-sweep-2026-06-17): the payout destination MUST be owned by the
    // `recipient` pubkey that the ZK `context` binds (compute_context hashes
    // recipient into the proof's public `context` signal). Pre-fix this was a
    // loose `mut` TokenAccount, so a permissionless relayer holding a valid
    // proof for recipient R could set `recipient_token_account` to a USDC
    // account THEY own (SPL Transfer only checks mint, not owner) and steal the
    // withdrawal while burning R's nullifier. Binding the token authority to
    // `recipient` closes the redirection.
    // `token::authority = recipient` enforces ownership; Anchor raises its
    // built-in ConstraintTokenOwner error on mismatch (the `@ custom_error`
    // form is only valid on `address`/`constraint`/`has_one`, not on
    // `token::authority`, so we rely on the built-in error here).
    #[account(
        mut,
        token::authority = recipient
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    // The relayer's fee destination must be owned by the relayer signer — a
    // relayer can only ever pay its own fee to itself, never redirect it.
    #[account(
        mut,
        token::authority = relayer
    )]
    pub relayer_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAspRoot<'info> {
    #[account(mut)]
    pub pool_state: Box<Account<'info, PoolState>>,

    pub postman: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + AgentRecord::INIT_SPACE,
        seeds = [b"agent", owner.key().as_ref(), hot_key.key().as_ref()],
        bump
    )]
    pub agent_record: Account<'info, AgentRecord>,

    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: hot key for this agent
    pub hot_key: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(mut)]
    pub pool_state: Box<Account<'info, PoolState>>,

    pub authority: Signer<'info>,
}

// --- State accounts ---

#[account]
pub struct PoolState {
    pub owner: Pubkey,
    pub postman: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    /// 32-byte BE field element. keccak256(pool_id || token_mint) % SNARK_FIELD.
    pub scope: [u8; 32],
    /// Latest LeanIMT root.
    pub tree_root: [u8; 32],
    /// Latest ASP root (set by postman).
    pub asp_root: [u8; 32],
    /// Number of leaves inserted.
    pub deposit_count: u64,
    pub vetting_fee_bps: u64,
    pub max_relay_fee_bps: u64,
    pub minimum_deposit: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub paused: bool,
    /// LeanIMT side-nodes + size + depth. Recomputes the root on demand.
    pub frontier: LeanImtFrontier,
    /// Ring buffer of recent state roots. A relayer can submit a proof
    /// against any of these — required because deposits land between proof
    /// generation and proof submission.
    pub known_state_roots: [[u8; 32]; HISTORICAL_ROOTS],
    /// Ring buffer write head.
    pub known_state_roots_idx: u8,
}

// Manual Space impl — anchor-derive-space's `InitSpace` macro panics on
// `[T; N]` fields. The layout below mirrors `PoolState` field-by-field.
impl anchor_lang::Space for PoolState {
    const INIT_SPACE: usize = 32 * 4                                  // owner, postman, token_mint, vault
        + 32 + 32 + 32                          // scope, tree_root, asp_root
        + 8 * 4                                 // deposit_count, vetting_fee_bps, max_relay_fee_bps, minimum_deposit
        + 1 + 1 + 1                             // bump, vault_bump, paused
        + <LeanImtFrontier as anchor_lang::Space>::INIT_SPACE
        + 32 * HISTORICAL_ROOTS                 // known_state_roots
        + 1; // known_state_roots_idx
}

#[account]
pub struct DepositRecord {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub precommitment: [u8; 32],
    pub commitment: [u8; 32],
    pub label: [u8; 32],
    pub amount: u64,
    pub index: u64,
    pub timestamp: i64,
    pub bump: u8,
}

impl anchor_lang::Space for DepositRecord {
    const INIT_SPACE: usize = 32 * 2 + 32 * 3 + 8 * 3 + 1;
}

#[account]
pub struct NullifierRecord {
    pub pool: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub spent: bool,
    pub bump: u8,
}

impl anchor_lang::Space for NullifierRecord {
    const INIT_SPACE: usize = 32 + 32 + 1 + 1;
}

#[account]
#[derive(InitSpace)]
pub struct AgentRecord {
    pub owner: Pubkey,
    #[max_len(64)]
    pub name: String,
    pub hot_key: Pubkey,
    pub max_spend_per_tx: u64,
    pub max_spend_per_day: u64,
    pub total_spent: u64,
    pub daily_spent: u64,
    pub tx_count: u64,
    pub last_reset_day: i64,
    pub registered_at: i64,
    pub bump: u8,
}

// --- Events ---

#[event]
pub struct DepositEvent {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub commitment: [u8; 32],
    pub label: [u8; 32],
    pub value: u64,
    pub index: u64,
    pub new_root: [u8; 32],
    pub new_depth: u8,
}

#[event]
pub struct WithdrawalEvent {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub value: u64,
    pub relay_fee: u64,
    pub new_commitment: [u8; 32],
    pub new_root: [u8; 32],
}

#[event]
pub struct AspRootUpdated {
    pub pool: Pubkey,
    pub new_root: [u8; 32],
    pub ipfs_cid: String,
}

// --- Errors ---

#[error_code]
pub enum ZX402Error {
    #[msg("Pool is paused")]
    PoolPaused,
    #[msg("Deposit below minimum")]
    BelowMinimumDeposit,
    #[msg("Nullifier already spent")]
    NullifierAlreadySpent,
    #[msg("Relay fee exceeds maximum")]
    RelayFeeTooHigh,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid proof")]
    InvalidProof,
    #[msg("Agent spend limit exceeded")]
    SpendLimitExceeded,
    #[msg("State root not recognized by pool")]
    UnknownStateRoot,
    #[msg("ASP root in proof does not match pool ASP root")]
    IncorrectAspRoot,
    #[msg("Withdrawal context hash does not match")]
    ContextMismatch,
    #[msg("Withdrawal bytes do not match recipient, relay fee, and relayer")]
    WithdrawalDataMismatch,
    #[msg("Withdrawn amount is invalid")]
    InvalidWithdrawalAmount,
    #[msg("Tree depth exceeds maximum")]
    InvalidTreeDepth,
    // audit-sweep-2026-06-17 account-binding error (B5). Recipient/relayer
    // token-account ownership is enforced via `token::authority`, which raises
    // Anchor's built-in ConstraintTokenOwner error, so no custom variants for
    // those are needed.
    #[msg("Vault account does not match the pool's vault PDA")]
    InvalidVault,
}
