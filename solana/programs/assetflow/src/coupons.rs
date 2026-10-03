//! Coupons: the instrument's terms on-chain, and each payment worked out by
//! the program from them.
//!
//! A payment runs in steps, and none of them needs the issuer's key.
//! `fix_register` pauses the mint once the record date has passed, so no unit
//! moves while the register is read, and prices the whole payment from the
//! supply. Anyone then counts the register into the program, one source at a
//! time: each holder account of the mint, each open redemption request, and
//! the private pool. Every source is counted once, and once the count adds up
//! to the supply, anyone closes it and the mint resumes. Anyone funds the
//! payment's own vault, and anyone pays each holder: the program computes the
//! amount from the terms, pays an eligible holder in the payment currency and
//! holds back the coupon of a holder who is no longer eligible.
//!
//! Nobody tells the program who holds what. While the mint is paused no
//! balance and no supply can change, and the supply is the sum of every
//! account's balance; so a count that reaches the supply, having counted each
//! source at most once, has left nobody out and counted nobody twice.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{pausable::instruction as pausable, pausable::PausableConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as MintState,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::private::{PrivatePool, PRIVATE_POOL_SEED};
use crate::redemptions::{RedemptionRequest, RedemptionStatus};
use crate::{holder_is_eligible, Asset, AssetFlowError, Registry, ASSET_SEED, INVESTOR_SEED};

pub const TERMS_SEED: &[u8] = b"terms";
pub const PAYOUT_SEED: &[u8] = b"payout";
pub const PAYOUT_VAULT_SEED: &[u8] = b"payout_vault";
pub const PAYMENT_SEED: &[u8] = b"paid";
pub const ENTITLED_SEED: &[u8] = b"entitled";
pub const COUNTED_SEED: &[u8] = b"counted";
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
    /// Mint paused; the register is being counted.
    Counting,
    /// Every unit counted, mint resumed; payment is open.
    Counted,
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
    /// Units counted into the register so far; the count is complete when
    /// this reaches the supply at the fix.
    pub counted: u64,
    /// What the whole payment costs, computed from the supply at the fix.
    pub required: u64,
    pub funded: u64,
    pub paid: u64,
    /// Coupons of holders who were not eligible when paid: kept in the vault.
    pub held_back: u64,
    pub payments: u32,
    /// The private pool, counted as one line: the units in the private escrow
    /// at the fix. Who among the private holders owns them is settled inside
    /// the private rollup.
    pub private_counted: bool,
    pub private_units: u64,
    /// The private pool's coupon, moved to the private cash vault.
    pub private_coupon: u64,
    pub private_paid: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

/// What one holder is owed a coupon on: every account they held at the fix,
/// and every unit they had waiting in the redemption escrow.
#[account]
#[derive(InitSpace)]
pub struct Entitlement {
    pub payout: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    /// Paid the rent; gets it back when the coupon is paid.
    pub payer: Pubkey,
    pub bump: u8,
}

/// Marks one source (a holder account or a redemption request) as counted
/// into one payment's register.
#[account]
#[derive(InitSpace)]
pub struct CountedSource {
    pub payout: Pubkey,
    /// The holder account or redemption request counted.
    pub source: Pubkey,
    /// Paid the rent; gets it back once the register is counted.
    pub payer: Pubkey,
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
    interest(terms, days, units)
}

/// Interest on `units` for `days` on the 30/360 basis, rounded down to the cent.
pub fn interest(terms: &Terms, days: i64, units: u64) -> Result<u64> {
    let raw = (units as u128)
        .checked_mul(terms.face_per_unit as u128)
        .and_then(|v| v.checked_mul(terms.coupon_bps as u128))
        .and_then(|v| v.checked_mul(days.max(0) as u128))
        .ok_or(error!(AssetFlowError::MathOverflow))?
        / (10_000u128 * 360);
    let cent = 10u128.pow(terms.currency_decimals.saturating_sub(2) as u32);
    u64::try_from(raw - raw % cent).map_err(|_| error!(AssetFlowError::MathOverflow))
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
    destination: &AccountInfo<'info>,
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
                to: destination.clone(),
                authority: payout.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        currency_mint.decimals,
    )
}

/// Add units to the register: to the holder's entitlement, and to the count.
fn count_into(
    payout: &mut Account<Payout>,
    entitlement: &mut Account<Entitlement>,
    holder: Pubkey,
    payer: Pubkey,
    bump: u8,
    units: u64,
) -> Result<()> {
    let counted = payout.counted.checked_add(units).ok_or(error!(AssetFlowError::MathOverflow))?;
    require!(counted <= payout.supply_at_fix, AssetFlowError::CountOverflow);
    payout.counted = counted;
    if entitlement.payout == Pubkey::default() {
        entitlement.payout = payout.key();
        entitlement.holder = holder;
        entitlement.payer = payer;
        entitlement.bump = bump;
    }
    entitlement.units = entitlement.units.checked_add(units).ok_or(error!(AssetFlowError::MathOverflow))?;
    Ok(())
}

pub fn fix(ctx: Context<FixRegister>, period: u8) -> Result<()> {
    let a = &ctx.accounts;
    let schedule = *a.terms.periods.get(period as usize).ok_or(error!(AssetFlowError::InvalidPeriod))?;
    // Coupons are counted in order, so a later register never opens while an
    // earlier one is still being counted.
    if period > 0 {
        let previous = a.previous.as_ref().ok_or(error!(AssetFlowError::PreviousPeriodOpen))?;
        require!(previous.status == PayoutStatus::Counted, AssetFlowError::PreviousPeriodOpen);
    }
    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= schedule.record_ts, AssetFlowError::RecordDateNotReached);
    let mint = a.mint.to_account_info();
    let (supply, paused) = mint_supply_and_paused(&mint)?;
    require!(!paused, AssetFlowError::RegisterWindowOpen);
    set_paused(true, &a.token_program, &mint, &a.asset)?;
    // The count must reach the supply, so the payment can be priced now and
    // funded while the register is still being counted.
    let required = coupon_amount(&a.terms, &schedule, supply)?;

    let payout = &mut ctx.accounts.payout;
    payout.asset = ctx.accounts.asset.key();
    payout.period = period;
    payout.status = PayoutStatus::Counting;
    payout.fixed_ts = clock.unix_timestamp;
    payout.fixed_slot = clock.slot;
    payout.supply_at_fix = supply;
    payout.required = required;
    payout.bump = ctx.bumps.payout;
    payout.vault_bump = ctx.bumps.vault;
    emit!(RegisterFixed { asset: payout.asset, period, supply, required, slot: clock.slot });
    Ok(())
}

pub fn count_account(mut ctx: Context<CountHolding>, period: u8) -> Result<()> {
    require!(ctx.accounts.payout.status == PayoutStatus::Counting, AssetFlowError::WrongPayoutStatus);
    // Counting a source twice is a no-op, so batches that overlap still land.
    if ctx.accounts.marker.payout != Pubkey::default() {
        return Ok(());
    }
    let units = ctx.accounts.holding.amount;
    require!(units > 0, AssetFlowError::InvalidAmount);
    let holder = ctx.accounts.holding.owner;
    let caller = ctx.accounts.caller.key();
    let a = &mut ctx.accounts;
    a.marker.payout = a.payout.key();
    a.marker.source = a.holding.key();
    a.marker.payer = caller;
    count_into(&mut a.payout, &mut a.entitlement, holder, caller, ctx.bumps.entitlement, units)?;
    emit!(HoldingCounted { asset: a.payout.asset, period, holder, source: a.holding.key(), units });
    Ok(())
}

pub fn count_request(mut ctx: Context<CountRedemption>, period: u8) -> Result<()> {
    require!(ctx.accounts.payout.status == PayoutStatus::Counting, AssetFlowError::WrongPayoutStatus);
    if ctx.accounts.marker.payout != Pubkey::default() {
        return Ok(());
    }
    // Requests cannot open or close while the mint is paused, and the escrow
    // holds exactly the open ones; it is never counted as a holding itself.
    require!(ctx.accounts.request.status == RedemptionStatus::Requested, AssetFlowError::RequestClosed);
    let units = ctx.accounts.request.units;
    let holder = ctx.accounts.request.holder;
    let caller = ctx.accounts.caller.key();
    let a = &mut ctx.accounts;
    a.marker.payout = a.payout.key();
    a.marker.source = a.request.key();
    a.marker.payer = caller;
    count_into(&mut a.payout, &mut a.entitlement, holder, caller, ctx.bumps.entitlement, units)?;
    emit!(HoldingCounted { asset: a.payout.asset, period, holder, source: a.request.key(), units });
    Ok(())
}

pub fn count_pool(ctx: Context<CountPrivatePool>, period: u8) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.payout.status == PayoutStatus::Counting, AssetFlowError::WrongPayoutStatus);
    require!(!a.payout.private_counted, AssetFlowError::AlreadyCounted);
    let units = a.escrow.amount;
    // Every unit in the private escrow came in through a deposit and leaves
    // only through a release.
    let expected = a.pool.total_deposited.checked_sub(a.pool.total_released).ok_or(error!(AssetFlowError::MathOverflow))?;
    require!(units == expected, AssetFlowError::PrivatePoolMismatch);
    let payout = &mut ctx.accounts.payout;
    let counted = payout.counted.checked_add(units).ok_or(error!(AssetFlowError::MathOverflow))?;
    require!(counted <= payout.supply_at_fix, AssetFlowError::CountOverflow);
    payout.counted = counted;
    payout.private_counted = true;
    payout.private_units = units;
    emit!(PrivatePoolCounted { asset: payout.asset, period, units });
    Ok(())
}

pub fn close_count(ctx: Context<CloseRegister>, period: u8) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.payout.status == PayoutStatus::Counting, AssetFlowError::WrongPayoutStatus);
    require!(a.payout.counted == a.payout.supply_at_fix, AssetFlowError::CountIncomplete);
    set_paused(false, &a.token_program, &a.mint.to_account_info(), &a.asset)?;
    let payout = &mut ctx.accounts.payout;
    payout.status = PayoutStatus::Counted;
    emit!(RegisterCounted { asset: payout.asset, period, units: payout.counted, required: payout.required });
    Ok(())
}

pub fn fund(ctx: Context<FundPayout>, period: u8, amount: u64) -> Result<()> {
    require!(amount > 0, AssetFlowError::InvalidAmount);
    let before = ctx.accounts.vault.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.currency_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.currency_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.currency_mint.decimals,
    )?;
    ctx.accounts.vault.reload()?;
    let received = ctx.accounts.vault.amount.checked_sub(before).ok_or(error!(AssetFlowError::MathOverflow))?;
    let payout = &mut ctx.accounts.payout;
    payout.funded = payout.funded.checked_add(received).ok_or(error!(AssetFlowError::MathOverflow))?;
    emit!(PayoutFunded { asset: payout.asset, period, amount: received, funded: payout.funded });
    Ok(())
}

/// What the payment has committed so far, plus `amount`, never above what it
/// was funded with.
fn commit_spend(payout: &Payout, amount: u64) -> Result<()> {
    let committed = payout
        .paid
        .checked_add(payout.held_back)
        .and_then(|v| v.checked_add(amount))
        .ok_or(error!(AssetFlowError::MathOverflow))?;
    require!(committed <= payout.funded, AssetFlowError::Overdrawn);
    Ok(())
}

pub fn pay(ctx: Context<PayEntitlement>, period: u8, holder: Pubkey) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.payout.status == PayoutStatus::Counted, AssetFlowError::WrongPayoutStatus);
    require!(a.payout.funded >= a.payout.required, AssetFlowError::Underfunded);
    let schedule = a.terms.periods[period as usize];
    let units = a.entitlement.units;
    let amount = coupon_amount(&a.terms, &schedule, units)?;
    let eligible = holder_is_eligible(&a.asset.key(), &a.registry, &holder, &a.investor.to_account_info())?;
    commit_spend(&a.payout, amount)?;
    if eligible && amount > 0 {
        pay_from_vault(
            &a.payout,
            &a.mint.key(),
            &a.vault,
            &a.destination.to_account_info(),
            &a.currency_mint,
            &a.currency_program,
            amount,
        )?;
    }

    let payout_key = ctx.accounts.payout.key();
    let payout = &mut ctx.accounts.payout;
    if eligible {
        payout.paid += amount;
    } else {
        payout.held_back += amount;
    }
    payout.payments += 1;
    let record = &mut ctx.accounts.record;
    record.payout = payout_key;
    record.holder = holder;
    record.units = units;
    record.amount = amount;
    record.held_back = !eligible;
    record.ts = Clock::get()?.unix_timestamp;
    emit!(CouponPaid { asset: payout.asset, period, holder, units, amount, held_back: !eligible });
    Ok(())
}

pub fn pay_pool(ctx: Context<PayPrivatePool>, period: u8) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.payout.status == PayoutStatus::Counted, AssetFlowError::WrongPayoutStatus);
    require!(a.payout.funded >= a.payout.required, AssetFlowError::Underfunded);
    require!(a.payout.private_counted && !a.payout.private_paid, AssetFlowError::WrongPayoutStatus);
    let schedule = a.terms.periods[period as usize];
    // One coupon on the whole pool; each private holder's share is rounded
    // down on their own holding inside the rollup, so the shares never add up
    // to more than this.
    let amount = coupon_amount(&a.terms, &schedule, a.payout.private_units)?;
    commit_spend(&a.payout, amount)?;
    if amount > 0 {
        pay_from_vault(
            &a.payout,
            &a.mint.key(),
            &a.vault,
            &a.cash_vault.to_account_info(),
            &a.currency_mint,
            &a.currency_program,
            amount,
        )?;
    }
    let payout = &mut ctx.accounts.payout;
    payout.paid += amount;
    payout.private_coupon = amount;
    payout.private_paid = true;
    emit!(PrivatePoolPaid { asset: payout.asset, period, units: payout.private_units, amount });
    Ok(())
}

pub fn release_marker(ctx: Context<ReleaseCounted>) -> Result<()> {
    require!(ctx.accounts.payout.status == PayoutStatus::Counted, AssetFlowError::WrongPayoutStatus);
    Ok(())
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
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
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
    pub payout: Box<Account<'info, Payout>>,
    /// The previous period's payment; required, and counted, from the second
    /// period on.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period.saturating_sub(1)]], bump = previous.bump)]
    pub previous: Option<Box<Account<'info, Payout>>>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = caller,
        token::mint = currency_mint,
        token::authority = payout,
        token::token_program = currency_program,
        seeds = [PAYOUT_VAULT_SEED, payout.key().as_ref()],
        bump
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct CountHolding<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    /// A Token-2022 account of this mint. The asset's own accounts (the
    /// escrows) are never a holding: their units are counted through the
    /// requests and the private pool.
    #[account(
        token::mint = mint,
        token::token_program = token_program,
        constraint = holding.owner != asset.key() @ AssetFlowError::NotAHolding
    )]
    pub holding: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + CountedSource::INIT_SPACE,
        seeds = [COUNTED_SEED, payout.key().as_ref(), holding.key().as_ref()],
        bump
    )]
    pub marker: Box<Account<'info, CountedSource>>,
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + Entitlement::INIT_SPACE,
        seeds = [ENTITLED_SEED, payout.key().as_ref(), holding.owner.as_ref()],
        bump
    )]
    pub entitlement: Box<Account<'info, Entitlement>>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct CountRedemption<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(has_one = asset)]
    pub request: Box<Account<'info, RedemptionRequest>>,
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + CountedSource::INIT_SPACE,
        seeds = [COUNTED_SEED, payout.key().as_ref(), request.key().as_ref()],
        bump
    )]
    pub marker: Box<Account<'info, CountedSource>>,
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + Entitlement::INIT_SPACE,
        seeds = [ENTITLED_SEED, payout.key().as_ref(), request.holder.as_ref()],
        bump
    )]
    pub entitlement: Box<Account<'info, Entitlement>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct CountPrivatePool<'info> {
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(seeds = [PRIVATE_POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = asset, has_one = escrow)]
    pub pool: Box<Account<'info, PrivatePool>>,
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct CloseRegister<'info> {
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: the asset's mint (bound by has_one); resumed here.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct FundPayout<'info> {
    pub funder: Signer<'info>,
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = currency_mint, token::authority = funder)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [PAYOUT_VAULT_SEED, payout.key().as_ref()], bump = payout.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub currency_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(period: u8, holder: Pubkey)]
pub struct PayEntitlement<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [PAYOUT_VAULT_SEED, payout.key().as_ref()], bump = payout.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Paid once: closed here, its rent going back to whoever counted it.
    #[account(
        mut,
        seeds = [ENTITLED_SEED, payout.key().as_ref(), holder.as_ref()],
        bump = entitlement.bump,
        close = rent_receiver
    )]
    pub entitlement: Box<Account<'info, Entitlement>>,
    /// CHECK: receives the entitlement's rent; pinned to who paid it.
    #[account(mut, address = entitlement.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = currency_mint,
        constraint = destination.owner == holder @ AssetFlowError::WrongDestination
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
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
    pub record: Box<Account<'info, PaymentRecord>>,
    pub currency_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct PayPrivatePool<'info> {
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [PAYOUT_VAULT_SEED, payout.key().as_ref()], bump = payout.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [PRIVATE_POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = asset, has_one = cash_vault)]
    pub pool: Box<Account<'info, PrivatePool>>,
    #[account(mut)]
    pub cash_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub currency_program: Interface<'info, TokenInterface>,
}

/// Return the rent of a counted marker once the register is counted.
#[derive(Accounts)]
#[instruction(period: u8, source: Pubkey)]
pub struct ReleaseCounted<'info> {
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: the asset's mint (bound by has_one).
    pub mint: UncheckedAccount<'info>,
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(
        mut,
        seeds = [COUNTED_SEED, payout.key().as_ref(), source.as_ref()],
        bump,
        has_one = payout,
        close = rent_receiver
    )]
    pub marker: Box<Account<'info, CountedSource>>,
    /// CHECK: receives the marker's rent; pinned to who paid it.
    #[account(mut, address = marker.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
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
    pub required: u64,
    pub slot: u64,
}

#[event]
pub struct HoldingCounted {
    pub asset: Pubkey,
    pub period: u8,
    pub holder: Pubkey,
    /// The holder account or redemption request counted.
    pub source: Pubkey,
    pub units: u64,
}

#[event]
pub struct PrivatePoolCounted {
    pub asset: Pubkey,
    pub period: u8,
    pub units: u64,
}

#[event]
pub struct RegisterCounted {
    pub asset: Pubkey,
    pub period: u8,
    pub units: u64,
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

#[event]
pub struct PrivatePoolPaid {
    pub asset: Pubkey,
    pub period: u8,
    pub units: u64,
    pub amount: u64,
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
}
