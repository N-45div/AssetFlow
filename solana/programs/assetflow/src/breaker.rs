//! A circuit breaker for the pools an asset trades in, without a transfer hook.
//!
//! A trading pool's token accounts belong to the pool's authority, which is no
//! investor, so the gate would never thaw them. Compliance can approve one
//! pool account as a venue: a record kept at the pool authority's investor
//! address, so Token ACL's existing account list already hands it to the gate.
//! The gate then thaws that one account only while the venue is open: a risk
//! decision says allow, it has not expired, and it was made after the venue
//! last tripped. The moment that stops being true, anyone may freeze it. A
//! frozen pool account can neither send nor receive units, so every swap
//! against the pool fails before it trades, in any program that handles
//! Token-2022. Wallet-to-wallet transfers never touch it.
//!
//! The price check needs no oracle. The program already prices the bond: face
//! plus accrued interest, what an early redemption pays. Anyone may compare
//! what the pool holds in the payment currency with what its units are worth
//! at that price, and trip the venue when the two stray too far apart. A
//! tripped venue reopens only on a decision made after the trip, and trips
//! again at the next check while its price is still out of line.
//!
//! What it does not do: it acts when someone checks and freezes, not inside
//! every transfer, so a watcher has to be running; and it does not stop a
//! compromised key from moving units it holds, only from selling them into the
//! pool once the pool is frozen.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::coupons::{Terms, TERMS_SEED};
use crate::redemptions::{accrued_interest, principal};
use crate::{Asset, AssetFlowError, Registry, INVESTOR_SEED};

/// The longest an allow decision may stand before someone must renew it.
pub const MAX_DECISION_SECS: i64 = 7 * 24 * 60 * 60;
/// The widest price band compliance may set: 50%.
pub const MAX_DEVIATION_BPS: u16 = 5_000;

/// One approved trading pool for one asset. Lives at the investor address of
/// the pool's authority, [INVESTOR_SEED, registry, owner], so the gate reads
/// it through the account Token ACL already passes.
#[account]
#[derive(InitSpace)]
pub struct Venue {
    pub registry: Pubkey,
    /// The pool's authority: the owner of its token accounts.
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// The pool's account of the asset, the only account of `owner` the gate thaws.
    pub base_vault: Pubkey,
    /// The pool's account of the payment currency, read to price the asset.
    pub quote_vault: Pubkey,
    /// Who posts risk decisions besides compliance: any risk system's key.
    pub risk_authority: Pubkey,
    pub allow: bool,
    pub decided_at: i64,
    pub valid_until: i64,
    /// The price check trips the venue past this deviation from the bond's value.
    pub max_deviation_bps: u16,
    /// When the price check last tripped the venue; 0 if never.
    pub tripped_at: i64,
    pub bump: u8,
}

impl Venue {
    /// Whether this record approves `token_account` of `mint`.
    pub fn covers(&self, mint: &Pubkey, token_account: &Pubkey) -> bool {
        self.mint == *mint && self.base_vault == *token_account
    }

    /// Open: an allow decision, not expired, made after the last trip.
    pub fn is_open(&self, now: i64) -> bool {
        self.allow && now <= self.valid_until && self.decided_at > self.tripped_at
    }
}

/// How far, in basis points, `quote` (what the pool holds in the currency)
/// strays from `fair` (what its units are worth at the bond's own price).
pub fn deviation_bps(quote: u64, fair: u64) -> Result<u64> {
    if fair == 0 {
        return Ok(if quote == 0 { 0 } else { u64::MAX });
    }
    let gap = (quote as i128 - fair as i128).unsigned_abs();
    let bps = gap
        .checked_mul(10_000)
        .ok_or(error!(AssetFlowError::MathOverflow))?
        / fair as u128;
    Ok(u64::try_from(bps).unwrap_or(u64::MAX))
}

pub fn approve(ctx: Context<ApproveVenue>, risk_authority: Pubkey, max_deviation_bps: u16) -> Result<()> {
    require!(
        max_deviation_bps > 0 && max_deviation_bps <= MAX_DEVIATION_BPS,
        AssetFlowError::InvalidVenue
    );
    let a = &ctx.accounts;
    let owner = a.base_vault.owner;
    // The asset's own vaults are servicing accounts, never a market.
    require_keys_neq!(owner, a.asset.key(), AssetFlowError::InvalidVenue);
    require_keys_eq!(a.quote_vault.owner, owner, AssetFlowError::InvalidVenue);
    require_keys_eq!(a.quote_vault.mint, a.terms.currency_mint, AssetFlowError::InvalidVenue);

    let venue = &mut ctx.accounts.venue;
    venue.registry = ctx.accounts.registry.key();
    venue.owner = owner;
    venue.mint = ctx.accounts.mint.key();
    venue.base_vault = ctx.accounts.base_vault.key();
    venue.quote_vault = ctx.accounts.quote_vault.key();
    venue.risk_authority = risk_authority;
    // Closed until a risk decision opens it.
    venue.allow = false;
    venue.decided_at = 0;
    venue.valid_until = 0;
    venue.max_deviation_bps = max_deviation_bps;
    venue.tripped_at = 0;
    venue.bump = ctx.bumps.venue;
    emit!(VenueApproved {
        registry: venue.registry,
        mint: venue.mint,
        owner,
        base_vault: venue.base_vault,
        quote_vault: venue.quote_vault,
        risk_authority,
        max_deviation_bps,
    });
    Ok(())
}

pub fn decide(ctx: Context<DecideVenue>, allow: bool, valid_for: i64) -> Result<()> {
    let signer = ctx.accounts.authority.key();
    require!(
        signer == ctx.accounts.venue.risk_authority || signer == ctx.accounts.registry.compliance,
        AssetFlowError::Unauthorized
    );
    let now = Clock::get()?.unix_timestamp;
    let venue = &mut ctx.accounts.venue;
    if allow {
        require!(valid_for > 0 && valid_for <= MAX_DECISION_SECS, AssetFlowError::InvalidVenue);
        venue.valid_until = now.checked_add(valid_for).ok_or(error!(AssetFlowError::MathOverflow))?;
    } else {
        venue.valid_until = now;
    }
    venue.allow = allow;
    venue.decided_at = now;
    emit!(VenueDecision { venue: venue.key(), by: signer, allow, decided_at: now, valid_until: venue.valid_until });
    Ok(())
}

pub fn check(ctx: Context<CheckVenue>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let units = ctx.accounts.base_vault.amount;
    let quote = ctx.accounts.quote_vault.amount;
    let terms = &ctx.accounts.terms;
    let fair = principal(terms.face_per_unit, units)?
        .checked_add(accrued_interest(terms, units, now)?)
        .ok_or(error!(AssetFlowError::MathOverflow))?;
    let deviation = deviation_bps(quote, fair)?;
    let venue = &mut ctx.accounts.venue;
    let tripped = units > 0 && deviation > venue.max_deviation_bps as u64;
    // A trip stands until a decision made after it; checking again changes nothing.
    if tripped && venue.tripped_at <= venue.decided_at {
        venue.tripped_at = now;
        emit!(VenueTripped { venue: venue.key(), units, quote, fair, deviation_bps: deviation, at: now });
    }
    emit!(VenueChecked { venue: venue.key(), units, quote, fair, deviation_bps: deviation, tripped });
    Ok(())
}

#[derive(Accounts)]
pub struct ApproveVenue<'info> {
    #[account(mut)]
    pub compliance: Signer<'info>,
    #[account(has_one = compliance @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
    #[account(has_one = registry, has_one = mint)]
    pub asset: Account<'info, Asset>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Account<'info, Terms>,
    #[account(token::mint = mint)]
    pub base_vault: InterfaceAccount<'info, TokenAccount>,
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
    /// Fails if the pool's authority already has an investor profile here.
    #[account(
        init,
        payer = compliance,
        space = 8 + Venue::INIT_SPACE,
        seeds = [INVESTOR_SEED, registry.key().as_ref(), base_vault.owner.as_ref()],
        bump
    )]
    pub venue: Account<'info, Venue>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DecideVenue<'info> {
    pub authority: Signer<'info>,
    pub registry: Account<'info, Registry>,
    #[account(mut, has_one = registry)]
    pub venue: Account<'info, Venue>,
}

#[derive(Accounts)]
pub struct CheckVenue<'info> {
    #[account(mut)]
    pub venue: Account<'info, Venue>,
    #[account(seeds = [TERMS_SEED, venue.mint.as_ref()], bump = terms.bump)]
    pub terms: Account<'info, Terms>,
    #[account(address = venue.base_vault)]
    pub base_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = venue.quote_vault)]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct CloseVenue<'info> {
    #[account(mut)]
    pub compliance: Signer<'info>,
    #[account(has_one = compliance @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
    #[account(mut, has_one = registry, close = compliance)]
    pub venue: Account<'info, Venue>,
}

#[event]
pub struct VenueApproved {
    pub registry: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub risk_authority: Pubkey,
    pub max_deviation_bps: u16,
}

#[event]
pub struct VenueDecision {
    pub venue: Pubkey,
    pub by: Pubkey,
    pub allow: bool,
    pub decided_at: i64,
    pub valid_until: i64,
}

#[event]
pub struct VenueChecked {
    pub venue: Pubkey,
    pub units: u64,
    pub quote: u64,
    pub fair: u64,
    pub deviation_bps: u64,
    pub tripped: bool,
}

#[event]
pub struct VenueTripped {
    pub venue: Pubkey,
    pub units: u64,
    pub quote: u64,
    pub fair: u64,
    pub deviation_bps: u64,
    pub at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn venue(allow: bool, decided_at: i64, valid_until: i64, tripped_at: i64) -> Venue {
        Venue {
            registry: Pubkey::default(),
            owner: Pubkey::default(),
            mint: Pubkey::default(),
            base_vault: Pubkey::default(),
            quote_vault: Pubkey::default(),
            risk_authority: Pubkey::default(),
            allow,
            decided_at,
            valid_until,
            max_deviation_bps: 500,
            tripped_at,
            bump: 0,
        }
    }

    #[test]
    fn deviation_is_the_gap_over_the_fair_value() {
        assert_eq!(deviation_bps(1_000_000, 1_000_000).unwrap(), 0);
        assert_eq!(deviation_bps(900_000, 1_000_000).unwrap(), 1_000);
        assert_eq!(deviation_bps(1_100_000, 1_000_000).unwrap(), 1_000);
        assert_eq!(deviation_bps(0, 1_000_000).unwrap(), 10_000);
        assert_eq!(deviation_bps(0, 0).unwrap(), 0);
        assert_eq!(deviation_bps(1, 0).unwrap(), u64::MAX);
    }

    #[test]
    fn open_only_on_a_fresh_allow_made_after_the_last_trip() {
        assert!(venue(true, 100, 200, 0).is_open(150));
        assert!(!venue(true, 100, 200, 0).is_open(201), "expired");
        assert!(!venue(false, 100, 200, 0).is_open(150), "blocked");
        assert!(!venue(true, 100, 200, 120).is_open(150), "tripped after the decision");
        assert!(!venue(true, 120, 200, 120).is_open(150), "decided in the same second as the trip");
        assert!(venue(true, 121, 200, 120).is_open(150), "reopened by a later decision");
        assert!(!venue(false, 0, 0, 0).is_open(0), "a new venue starts closed");
    }
}
