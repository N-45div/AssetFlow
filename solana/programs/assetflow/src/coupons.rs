//! Coupons: the instrument's terms on-chain, and each payment worked out by
//! the program from them.
//!
//! A payment runs in four steps. `fix_register` pauses the mint once the record
//! date has passed, so no unit moves while the register is read. The issuer
//! then commits a Merkle root over (holder, units) and the total, which must
//! equal the supply at the fix; that unpauses the mint and fixes what the whole
//! payment costs. Anyone funds the payment's own vault. Anyone then pays each
//! holder by proving their leaf: the program computes the amount from the terms,
//! pays an eligible holder in the payment currency and holds back the coupon of
//! a holder who is no longer eligible.
//!
//! Leaves carry units, never cash, so a wrong root can at worst move units
//! between holders; it can never make the payment cost more than the total
//! committed, and no payment can reach another payment's vault.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use solana_sha256_hasher::hashv;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{pausable::instruction as pausable, pausable::PausableConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as MintState,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{Asset, AssetFlowError, Registry, ASSET_SEED, INVESTOR_SEED};

pub const TERMS_SEED: &[u8] = b"terms";
pub const PAYOUT_SEED: &[u8] = b"payout";
pub const PAYOUT_VAULT_SEED: &[u8] = b"payout_vault";
pub const PAYMENT_SEED: &[u8] = b"paid";
pub const MAX_PERIODS: usize = 8;

/// One coupon period. Accrual dates are the nominal dates the coupon is
/// computed on (UTC midnight); the record and payment times say when the
/// register may be fixed and when the coupon is due.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct Period {
    pub accrual_start: i64,
    pub accrual_end: i64,
    pub record_ts: i64,
    pub payment_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Terms {
    pub asset: Pubkey,
    pub currency_mint: Pubkey,
    pub currency_decimals: u8,
    /// Face amount of one base unit of the asset, in currency base units.
    pub face_per_unit: u64,
    /// Annual coupon rate in basis points (1000 = 10%).
    pub coupon_bps: u16,
    #[max_len(8)]
    pub periods: Vec<Period>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum PayoutStatus {
    /// Mint paused; the register is being read.
    RegisterFixed,
    /// Root committed, mint resumed; funding and payment are open.
    Committed,
}

#[account]
#[derive(InitSpace)]
pub struct Payout {
    pub asset: Pubkey,
    pub period: u8,
    pub status: PayoutStatus,
    pub fixed_ts: i64,
    pub fixed_slot: u64,
    pub supply_at_fix: u64,
    pub root: [u8; 32],
    pub total_units: u64,
    /// What the whole payment costs, computed from the total when committed.
    pub required: u64,
    pub funded: u64,
    pub paid: u64,
    /// Coupons of holders who were not eligible when paid: kept in the vault.
    pub held_back: u64,
    pub payments: u32,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PaymentRecord {
    pub payout: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    pub amount: u64,
    pub held_back: bool,
    pub ts: i64,
}

/// Civil date (year, month, day) for a count of days since 1970-01-01.
/// Howard Hinnant's days-to-civil algorithm, exact for every i64 day count
/// this program will meet.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// Days between two dates on the 30/360 basis (MSRB Rule G-33): a 31st start
/// counts as the 30th, and a 31st end counts as the 30th when the start is
/// the 30th or 31st.
pub fn days_30_360(start_ts: i64, end_ts: i64) -> i64 {
    let (y1, m1, d1) = civil_from_days(start_ts.div_euclid(86_400));
    let (y2, m2, d2) = civil_from_days(end_ts.div_euclid(86_400));
    let d1 = if d1 == 31 { 30 } else { d1 };
    let d2 = if d2 == 31 && d1 >= 30 { 30 } else { d2 };
    360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1)
}

/// The coupon on a holding of `units` for one period, rounded down to the
/// cent. Computed on the holding as a whole, never per note, so a larger
/// holding is never short-changed by per-note rounding; and since the sum of
/// rounded-down parts never exceeds the rounded-down whole, a payment funded
/// for its total always covers every holder.
pub fn coupon_amount(terms: &Terms, period: &Period, units: u64) -> Result<u64> {
    let days = days_30_360(period.accrual_start, period.accrual_end);
    require!(days > 0, AssetFlowError::InvalidTerms);
    let raw = (units as u128)
        .checked_mul(terms.face_per_unit as u128)
        .and_then(|v| v.checked_mul(terms.coupon_bps as u128))
        .and_then(|v| v.checked_mul(days as u128))
        .ok_or(error!(AssetFlowError::MathOverflow))?
        / (10_000u128 * 360);
    let cent = 10u128.pow(terms.currency_decimals.saturating_sub(2) as u32);
    u64::try_from(raw - raw % cent).map_err(|_| error!(AssetFlowError::MathOverflow))
}

/// A leaf: domain byte 0, the payment it belongs to, the holder, their units.
/// Binding the payment makes a proof for one payment useless for another.
pub fn leaf(payout: &Pubkey, holder: &Pubkey, units: u64) -> [u8; 32] {
    hashv(&[&[0u8][..], payout.as_ref(), holder.as_ref(), &units.to_le_bytes()[..]]).to_bytes()
}

/// Inner nodes: domain byte 1 and the sorted pair, so a leaf can never pose
/// as a node.
pub fn verify_proof(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let mut node = leaf;
    for sibling in proof {
        let (a, b) = if node <= *sibling { (node, *sibling) } else { (*sibling, node) };
        node = hashv(&[&[1u8][..], &a[..], &b[..]]).to_bytes();
    }
    node == *root
}

pub fn validate_periods(periods: &[Period]) -> Result<()> {
    require!(!periods.is_empty() && periods.len() <= MAX_PERIODS, AssetFlowError::InvalidTerms);
    let mut previous: Option<&Period> = None;
    for p in periods {
        require!(p.accrual_start < p.accrual_end, AssetFlowError::InvalidTerms);
        require!(p.record_ts <= p.payment_ts, AssetFlowError::InvalidTerms);
        if let Some(prev) = previous {
            require!(p.accrual_start >= prev.accrual_end, AssetFlowError::InvalidTerms);
            require!(p.record_ts >= prev.payment_ts, AssetFlowError::InvalidTerms);
        }
        previous = Some(p);
    }
    Ok(())
}

/// Pause or resume the asset's mint, signing as the asset account.
pub fn set_paused<'info>(
    paused: bool,
    token_program: &Program<'info, Token2022>,
    mint: &AccountInfo<'info>,
    asset: &Account<'info, Asset>,
) -> Result<()> {
    let ix = if paused {
        pausable::pause(&token_program.key(), &mint.key(), &asset.key(), &[])?
    } else {
        pausable::resume(&token_program.key(), &mint.key(), &asset.key(), &[])?
    };
    let mint_key = mint.key();
    let seeds: &[&[u8]] = &[ASSET_SEED, mint_key.as_ref(), &[asset.bump]];
    invoke_signed(
        &ix,
        &[mint.clone(), asset.to_account_info(), token_program.to_account_info()],
        &[seeds],
    )?;
    Ok(())
}

/// Supply and pause state of the asset's mint, read from its data.
pub fn mint_supply_and_paused(mint: &AccountInfo) -> Result<(u64, bool)> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(AssetFlowError::MintNotToken2022))?;
    let paused = state
        .get_extension::<PausableConfig>()
        .map(|c| bool::from(c.paused))
        .unwrap_or(false);
    Ok((state.base.supply, paused))
}

/// Pay out of a payment's vault, signing as the payment.
pub fn pay_from_vault<'info>(
    payout: &Account<'info, Payout>,
    mint: &Pubkey,
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    currency_mint: &InterfaceAccount<'info, Mint>,
    currency_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[PAYOUT_SEED, mint.as_ref(), &[payout.period], &[payout.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            currency_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: currency_mint.to_account_info(),
                to: destination.to_account_info(),
                authority: payout.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        currency_mint.decimals,
    )
}

#[derive(Accounts)]
pub struct SetTerms<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(has_one = issuer @ AssetFlowError::Unauthorized)]
    pub asset: Account<'info, Asset>,
    pub currency_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = issuer,
        space = 8 + Terms::INIT_SPACE,
        seeds = [TERMS_SEED, asset.mint.as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct FixRegister<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(has_one = mint)]
    pub asset: Account<'info, Asset>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Account<'info, Terms>,
    /// CHECK: the asset's mint (bound by has_one); paused here.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = caller,
        space = 8 + Payout::INIT_SPACE,
        seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]],
        bump
    )]
    pub payout: Account<'info, Payout>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct CommitEntitlements<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(has_one = issuer @ AssetFlowError::Unauthorized, has_one = mint)]
    pub asset: Account<'info, Asset>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Account<'info, Terms>,
    /// CHECK: the asset's mint (bound by has_one); resumed here.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Account<'info, Payout>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = issuer,
        token::mint = currency_mint,
        token::authority = payout,
        token::token_program = currency_program,
        seeds = [PAYOUT_VAULT_SEED, payout.key().as_ref()],
        bump
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct FundPayout<'info> {
    pub funder: Signer<'info>,
    #[account(has_one = mint)]
    pub asset: Account<'info, Asset>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Account<'info, Terms>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Account<'info, Payout>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = currency_mint, token::authority = funder)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [PAYOUT_VAULT_SEED, payout.key().as_ref()], bump = payout.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub currency_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(period: u8, holder: Pubkey)]
pub struct PayEntitlement<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = mint, has_one = registry)]
    pub asset: Account<'info, Asset>,
    pub registry: Account<'info, Registry>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Account<'info, Terms>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Account<'info, Payout>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [PAYOUT_VAULT_SEED, payout.key().as_ref()], bump = payout.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = currency_mint,
        constraint = destination.owner == holder @ AssetFlowError::WrongDestination
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: may not exist. A holder with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), holder.as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + PaymentRecord::INIT_SPACE,
        seeds = [PAYMENT_SEED, payout.key().as_ref(), holder.as_ref()],
        bump
    )]
    pub record: Account<'info, PaymentRecord>,
    pub currency_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct TermsSet {
    pub asset: Pubkey,
    pub currency_mint: Pubkey,
    pub face_per_unit: u64,
    pub coupon_bps: u16,
    pub periods: u8,
}

#[event]
pub struct RegisterFixed {
    pub asset: Pubkey,
    pub period: u8,
    pub supply: u64,
    pub slot: u64,
}

#[event]
pub struct EntitlementsCommitted {
    pub asset: Pubkey,
    pub period: u8,
    pub root: [u8; 32],
    pub total_units: u64,
    pub required: u64,
}

#[event]
pub struct PayoutFunded {
    pub asset: Pubkey,
    pub period: u8,
    pub amount: u64,
    pub funded: u64,
}

#[event]
pub struct CouponPaid {
    pub asset: Pubkey,
    pub period: u8,
    pub holder: Pubkey,
    pub units: u64,
    pub amount: u64,
    pub held_back: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(y: i64, m: i64, d: i64) -> i64 {
        // inverse of civil_from_days, for the tests only
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = if m > 2 { m - 3 } else { m + 9 };
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        (era * 146_097 + doe - 719_468) * 86_400
    }

    fn terms(bps: u16) -> Terms {
        Terms {
            asset: Pubkey::default(),
            currency_mint: Pubkey::default(),
            currency_decimals: 6,
            face_per_unit: 1_000_000, // one unit = US$1 of face
            coupon_bps: bps,
            periods: vec![],
            bump: 0,
        }
    }

    fn period(start: i64, end: i64) -> Period {
        Period { accrual_start: start, accrual_end: end, record_ts: 0, payment_ts: 0 }
    }

    #[test]
    fn civil_dates_round_trip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(ts(2026, 10, 1) / 86_400), (2026, 10, 1));
        assert_eq!(civil_from_days(ts(2028, 2, 29) / 86_400), (2028, 2, 29));
    }

    #[test]
    fn thirty_360_counts() {
        assert_eq!(days_30_360(ts(2026, 10, 1), ts(2027, 4, 1)), 180);
        assert_eq!(days_30_360(ts(2027, 1, 31), ts(2027, 3, 31)), 60);
        assert_eq!(days_30_360(ts(2027, 4, 15), ts(2027, 6, 15)), 60);
        assert_eq!(days_30_360(ts(2027, 3, 1), ts(2027, 3, 31)), 30);
    }

    #[test]
    fn a_regular_half_year_pays_fifty_dollars_per_thousand() {
        let p = period(ts(2026, 10, 1), ts(2027, 4, 1));
        assert_eq!(coupon_amount(&terms(1000), &p, 1_000).unwrap(), 50_000_000);
        assert_eq!(coupon_amount(&terms(1000), &p, 3_000).unwrap(), 150_000_000);
    }

    #[test]
    fn rounds_down_to_the_cent_on_the_whole_holding() {
        // 60 days of 10% on US$1,000 = US$16.666… -> US$16.66; on US$3,000 = US$50.00 exactly,
        // not 3 x 16.66 = 49.98
        let p = period(ts(2027, 4, 15), ts(2027, 6, 15));
        assert_eq!(coupon_amount(&terms(1000), &p, 1_000).unwrap(), 16_660_000);
        assert_eq!(coupon_amount(&terms(1000), &p, 3_000).unwrap(), 50_000_000);
    }

    #[test]
    fn parts_never_exceed_the_whole() {
        let p = period(ts(2027, 4, 15), ts(2027, 6, 15));
        let t = terms(1000);
        let parts = [1u64, 7, 333, 1_001, 2_659];
        let sum: u64 = parts.iter().map(|u| coupon_amount(&t, &p, *u).unwrap()).sum();
        assert!(sum <= coupon_amount(&t, &p, parts.iter().sum()).unwrap());
    }

    #[test]
    fn a_proof_holds_only_for_its_own_payment() {
        let payout = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let (a, b, c) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let la = leaf(&payout, &a, 3_000);
        let lb = leaf(&payout, &b, 1_000);
        let lc = leaf(&payout, &c, 1_500);
        let pair = |x: [u8; 32], y: [u8; 32]| {
            let (p, q) = if x <= y { (x, y) } else { (y, x) };
            hashv(&[&[1u8][..], &p[..], &q[..]]).to_bytes()
        };
        let ab = pair(la, lb);
        let root = pair(ab, lc);
        assert!(verify_proof(&[lb, lc], &root, la));
        assert!(verify_proof(&[ab], &root, lc));
        assert!(!verify_proof(&[lb, lc], &root, leaf(&payout, &a, 3_001)));
        assert!(!verify_proof(&[lb, lc], &root, leaf(&other, &a, 3_000)));
    }
}
