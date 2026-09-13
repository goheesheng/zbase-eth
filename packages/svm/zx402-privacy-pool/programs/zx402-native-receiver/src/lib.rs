use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_lang::InstructionData;
use anchor_spl::token::{Token, TokenAccount};
use zx402_privacy_pool::instruction::RelayWithdrawal;

declare_id!("8NZ1DwqbnTuTR2k1mAmsRFxQHBYkQgYs5UHaGD7onAmy");

const INTENT_SEED: &[u8] = b"intent";
const RECIPIENT_SEED: &[u8] = b"recipient";

#[program]
pub mod zx402_native_receiver {
    use super::*;

    /// Create an on-chain price commitment before an untrusted relayer can
    /// fulfill it. Each order receives a unique program-owned PDA, so the ZK
    /// proof's recipient binding also binds the payment to this exact order.
    pub fn create_payment_intent(
        ctx: Context<CreatePaymentIntent>,
        order_id: [u8; 32],
        expected_amount: u64,
    ) -> Result<()> {
        require!(expected_amount > 0, ReceiverError::InvalidExpectedAmount);

        let intent = &mut ctx.accounts.payment_intent;
        intent.merchant = ctx.accounts.merchant.key();
        intent.order_id = order_id;
        intent.recipient_authority = ctx.accounts.recipient_authority.key();
        intent.expected_amount = expected_amount;
        intent.fulfilled = false;
        intent.nullifier_hash = [0u8; 32];
        intent.fulfilled_slot = 0;
        intent.intent_bump = ctx.bumps.payment_intent;
        intent.recipient_bump = ctx.bumps.recipient_authority;

        emit!(PaymentIntentCreated {
            payment_intent: intent.key(),
            merchant: intent.merchant,
            order_id,
            recipient: intent.recipient_authority,
            expected_amount,
        });

        Ok(())
    }

    /// Atomically settle a private-pool withdrawal and mark the merchant's
    /// order fulfilled. Any CPI, token-balance, or state error aborts the
    /// entire Solana instruction, including the pool transfer and nullifier.
    pub fn fulfill_private_payment(
        ctx: Context<FulfillPrivatePayment>,
        order_id: [u8; 32],
        nullifier_hash: [u8; 32],
        relay: RelayWithdrawal,
    ) -> Result<()> {
        let intent = &ctx.accounts.payment_intent;
        require!(!intent.fulfilled, ReceiverError::AlreadyFulfilled);
        require!(
            relay.nullifier_hash == nullifier_hash,
            ReceiverError::WrongNullifier
        );
        require!(
            relay.recipient == ctx.accounts.recipient_authority.key(),
            ReceiverError::WrongRecipient
        );
        let relay_instruction_data = relay.data();

        let balance_before = ctx.accounts.recipient_token_account.amount;
        let relay_instruction = Instruction {
            program_id: ctx.accounts.privacy_pool_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.pool_state.key(), false),
                AccountMeta::new(ctx.accounts.nullifier_record.key(), false),
                AccountMeta::new(ctx.accounts.vault.key(), false),
                AccountMeta::new(ctx.accounts.recipient_token_account.key(), false),
                AccountMeta::new(ctx.accounts.relayer_token_account.key(), false),
                AccountMeta::new(ctx.accounts.relayer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: relay_instruction_data,
        };
        invoke(
            &relay_instruction,
            &[
                ctx.accounts.pool_state.to_account_info(),
                ctx.accounts.nullifier_record.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.recipient_token_account.to_account_info(),
                ctx.accounts.relayer_token_account.to_account_info(),
                ctx.accounts.relayer.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.privacy_pool_program.to_account_info(),
            ],
        )?;

        // Reload after CPI. The fulfillment state is written only after the
        // exact recipient-side token delta has been observed.
        ctx.accounts.recipient_token_account.reload()?;
        let balance_after = ctx.accounts.recipient_token_account.amount;
        let received = balance_after
            .checked_sub(balance_before)
            .ok_or(ReceiverError::ArithmeticOverflow)?;
        require_eq!(
            received,
            intent.expected_amount,
            ReceiverError::IncorrectTokenDelta
        );

        let intent = &mut ctx.accounts.payment_intent;
        intent.fulfilled = true;
        intent.nullifier_hash = nullifier_hash;
        intent.fulfilled_slot = Clock::get()?.slot;

        emit!(PrivatePaymentFulfilled {
            payment_intent: intent.key(),
            merchant: intent.merchant,
            order_id,
            recipient: intent.recipient_authority,
            amount: received,
            nullifier_hash,
            relayer: ctx.accounts.relayer.key(),
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 32])]
pub struct CreatePaymentIntent<'info> {
    #[account(
        init,
        payer = merchant,
        space = 8 + PaymentIntent::INIT_SPACE,
        seeds = [INTENT_SEED, merchant.key().as_ref(), &order_id],
        bump
    )]
    pub payment_intent: Box<Account<'info, PaymentIntent>>,

    /// CHECK: This PDA is only a token-account authority. Its address is
    /// constrained here and stored in the payment intent.
    #[account(
        seeds = [RECIPIENT_SEED, payment_intent.key().as_ref()],
        bump
    )]
    pub recipient_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub merchant: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 32], nullifier_hash: [u8; 32])]
pub struct FulfillPrivatePayment<'info> {
    #[account(
        mut,
        seeds = [INTENT_SEED, payment_intent.merchant.as_ref(), &order_id],
        bump = payment_intent.intent_bump,
        has_one = recipient_authority @ ReceiverError::WrongRecipient
    )]
    pub payment_intent: Box<Account<'info, PaymentIntent>>,

    /// CHECK: Program-owned token authority, constrained to this exact order.
    #[account(address = payment_intent.recipient_authority @ ReceiverError::WrongRecipient)]
    pub recipient_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient_authority.key()
            @ ReceiverError::WrongRecipientTokenOwner,
        constraint = recipient_token_account.mint == vault.mint
            @ ReceiverError::WrongTokenMint
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: The privacy-pool program owns and validates this state account.
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: Initialized and constrained by the privacy-pool CPI.
    #[account(
        mut,
        seeds = [b"nullifier", pool_state.key().as_ref(), &nullifier_hash],
        bump,
        seeds::program = privacy_pool_program.key()
    )]
    pub nullifier_record: UncheckedAccount<'info>,

    /// CHECK: The privacy-pool CPI constrains this account to the pool vault.
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: The privacy-pool CPI constrains the token owner to `relayer` and
    /// SPL Token rejects a mint mismatch during transfer.
    #[account(mut)]
    pub relayer_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    pub privacy_pool_program: Program<'info, zx402_privacy_pool::program::Zx402PrivacyPool>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct PaymentIntent {
    pub merchant: Pubkey,
    pub order_id: [u8; 32],
    pub recipient_authority: Pubkey,
    pub expected_amount: u64,
    pub fulfilled: bool,
    pub nullifier_hash: [u8; 32],
    pub fulfilled_slot: u64,
    pub intent_bump: u8,
    pub recipient_bump: u8,
}

#[event]
pub struct PaymentIntentCreated {
    pub payment_intent: Pubkey,
    pub merchant: Pubkey,
    pub order_id: [u8; 32],
    pub recipient: Pubkey,
    pub expected_amount: u64,
}

#[event]
pub struct PrivatePaymentFulfilled {
    pub payment_intent: Pubkey,
    pub merchant: Pubkey,
    pub order_id: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub nullifier_hash: [u8; 32],
    pub relayer: Pubkey,
}

#[error_code]
pub enum ReceiverError {
    #[msg("Expected payment amount must be positive")]
    InvalidExpectedAmount,
    #[msg("Payment intent has already been fulfilled")]
    AlreadyFulfilled,
    #[msg("Pool relay nullifier does not match the receiver instruction")]
    WrongNullifier,
    #[msg("Recipient token balance did not increase by the intent amount")]
    IncorrectTokenDelta,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Recipient PDA does not match this payment intent")]
    WrongRecipient,
    #[msg("Recipient token account is not controlled by the recipient PDA")]
    WrongRecipientTokenOwner,
    #[msg("Token account mint does not match the privacy pool")]
    WrongTokenMint,
}
