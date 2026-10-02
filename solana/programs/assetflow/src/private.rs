//! Private holdings: units parked in an escrow on Solana, each holder's share
//! kept in an account that lives in a MagicBlock Private Ephemeral Rollup.

use anchor_lang::prelude::*;

pub const PRIVATE_POOL_SEED: &[u8] = b"private_pool";

/// An asset's private pool, on Solana. Its counters are public: every unit
/// that goes into or comes out of private holdings moves on Solana.
#[account]
#[derive(InitSpace)]
pub struct PrivatePool {
    pub asset: Pubkey,
    /// The rollup every private account of this asset is delegated to.
    pub validator: Pubkey,
    /// A reader every private holding admits besides the holder, the issuer
    /// and compliance; the default key for none.
    pub auditor: Pubkey,
    /// Units parked in private holdings, owned by the asset account.
    pub escrow: Pubkey,
    /// Private holders' coupons, until each takes theirs out.
    pub cash_vault: Pubkey,
    pub total_deposited: u64,
    pub total_released: u64,
    pub cash_released: u64,
    pub bump: u8,
    pub escrow_bump: u8,
    pub cash_bump: u8,
}
