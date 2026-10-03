//! Redemptions and maturity.
//!
//! An early redemption is a request the issuer answers. The holder moves the
//! units into the asset's escrow, where they wait. The issuer either settles,
//! burning them and paying in the same transaction at a price the program
//! computes (face plus accrued interest), or rejects, and the units go back.
//! Until the issuer answers, the holder can withdraw the request.
//!
//! Maturity closes the instrument. Once the last payment date has passed and
//! every coupon's register is counted, anyone can start it: the mint
//! authority is dropped, so no unit can ever be issued again, and the face of
//! every unit outstanding falls due. Once the issuer has funded all of it,
//! anyone can redeem any holding: its units burn and the face goes to its
//! owner. A holder who is not eligible keeps their units, and the principal
//! they are owed stays in the vault until they are eligible again.
//!
//! Units waiting in escrow still belong to whoever asked to redeem them: a
//! register read on a record date counts them to that holder, not to the asset.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Burn, Mint, SetAuthority, TokenAccount, TokenInterface, TransferChecked};

use crate::coupons::{days_30_360, interest, mint_supply_and_paused, Payout, PayoutStatus, Terms, PAYOUT_SEED, TERMS_SEED};
use crate::{
    holder_is_eligible, token_acl_set_frozen, Asset, AssetFlowError, Registry, ASSET_SEED, INVESTOR_SEED,
    MINT_CONFIG_SEED, TOKEN_ACL_ID,
};

pub const REDEMPTION_SEED: &[u8] = b"redemption";
pub const MATURITY_SEED: &[u8] = b"maturity";
pub const MATURITY_VAULT_SEED: &[u8] = b"maturity_vault";
pub const REDEEMED_SEED: &[u8] = b"redeemed";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum RedemptionStatus {
    /// Units in escrow, waiting for the issuer.
    Requested,
    /// Units burned and paid for.
    Settled,
    /// Refused by the issuer; units returned.
    Rejected,
    /// Withdrawn by the holder; units returned.
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct RedemptionRequest {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub id: u32,
    pub units: u64,
    pub status: RedemptionStatus,
    pub requested_ts: i64,
    pub closed_ts: i64,
    /// What settlement paid: the face of the units, and the interest accrued.
    pub principal: u64,
    pub interest: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Maturity {
    pub asset: Pubkey,
    pub currency_mint: Pubkey,
    pub face_per_unit: u64,
    pub started_ts: i64,
    /// Units outstanding when maturity started, and the face they are owed.
    pub units: u64,
    pub required: u64,
    pub funded: u64,
    pub paid: u64,
    pub units_redeemed: u64,
    pub redemptions: u32,
    pub bump: u8,
    pub vault_bump: u8,
}

/// What one holder was paid at maturity, across every account they held.
#[account]
#[derive(InitSpace)]
pub struct MaturityRecord {
    pub maturity: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    pub amount: u64,
    pub ts: i64,
}

/// Face value of `units`, in currency base units.
pub fn principal(face_per_unit: u64, units: u64) -> Result<u64> {
    units.checked_mul(face_per_unit).ok_or(error!(AssetFlowError::MathOverflow))
}

/// Interest accrued on `units` at `now`: 30/360 from the start of the running
/// period, rounded down to the cent. Nothing once that period's record date
/// has passed, since the holder on the register then takes the whole coupon.
pub fn accrued_interest(terms: &Terms, units: u64, now: i64) -> Result<u64> {
    match terms.periods.iter().find(|p| p.accrual_start <= now && now < p.accrual_end) {
        Some(p) if now < p.record_ts => interest(terms, days_30_360(p.accrual_start, now), units),
        _ => Ok(0),
    }
}

/// Maturity drops the mint authority; nothing else does.
pub fn is_matured(mint: &Mint) -> bool {
    mint.mint_authority.is_none()
}

pub(crate) fn asset_seeds<'a>(mint: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [ASSET_SEED, mint.as_ref(), bump]
}

/// Move units or cash out of an account a PDA of this program owns.
#[allow(clippy::too_many_arguments)]
pub(crate) fn transfer_signed<'info>(
    program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            program.key(),
            TransferChecked { from: from.clone(), mint: mint.to_account_info(), to: to.clone(), authority: authority.clone() },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Burn units, signing as the asset: the escrow's owner, and every holder
/// account's permanent delegate.
fn burn_as_asset<'info>(
    token_program: &Program<'info, Token2022>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &AccountInfo<'info>,
    asset: &Account<'info, Asset>,
    units: u64,
) -> Result<()> {
    let mint_key = mint.key();
    let bump = [asset.bump];
    let seeds = asset_seeds(&mint_key, &bump);
    token_interface::burn(
        CpiContext::new_with_signer(
            token_program.key(),
            Burn { mint: mint.to_account_info(), from: from.clone(), authority: asset.to_account_info() },
            &[&seeds],
        ),
        units,
    )
}

/// The escrow is frozen except inside these instructions, so no unit reaches
/// it but through a request, and what it holds is exactly the open requests.
/// The asset thaws it with Token ACL's authority thaw; the gate's own path
/// would call back into this program, which Solana does not allow, and the
/// gate refuses to thaw an account the asset owns in any case.
pub(crate) fn open_escrow<'info>(
    frozen: bool,
    asset: &Account<'info, Asset>,
    mint: &AccountInfo<'info>,
    escrow: &AccountInfo<'info>,
    mint_config: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    if frozen {
        token_acl_set_frozen(false, asset, mint, escrow, mint_config, token_program)?;
    }
    Ok(())
}

pub(crate) fn close_escrow<'info>(
    asset: &Account<'info, Asset>,
    mint: &AccountInfo<'info>,
    escrow: &AccountInfo<'info>,
    mint_config: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    token_acl_set_frozen(true, asset, mint, escrow, mint_config, token_program)
}

pub fn open_request(ctx: Context<RequestRedemption>, id: u32, units: u64) -> Result<()> {
    require!(units > 0, AssetFlowError::InvalidAmount);
    let a = &ctx.accounts;
    require!(!is_matured(&a.mint), AssetFlowError::AssetMatured);
    require!(!mint_supply_and_paused(&a.mint.to_account_info())?.1, AssetFlowError::MintPaused);
    require!(
        holder_is_eligible(&a.asset.key(), &a.registry, &a.holder.key(), &a.investor.to_account_info())?,
        AssetFlowError::NotEligible
    );
    let mint = a.mint.to_account_info();
    let escrow = a.escrow.to_account_info();
    let token_program = a.token_program.to_account_info();
    open_escrow(a.escrow.is_frozen(), &a.asset, &mint, &escrow, &a.mint_config, &token_program)?;
    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.source.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.escrow.to_account_info(),
                authority: a.holder.to_account_info(),
            },
        ),
        units,
        a.mint.decimals,
    )?;
    close_escrow(&a.asset, &mint, &escrow, &a.mint_config, &token_program)?;

    let asset = a.asset.key();
    let holder = a.holder.key();
    let request = &mut ctx.accounts.request;
    request.asset = asset;
    request.holder = holder;
    request.id = id;
    request.units = units;
    request.status = RedemptionStatus::Requested;
    request.requested_ts = Clock::get()?.unix_timestamp;
    request.bump = ctx.bumps.request;
    emit!(RedemptionRequested { asset, holder, id, units });
    Ok(())
}

pub fn settle_request(ctx: Context<SettleRedemption>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.request.status == RedemptionStatus::Requested, AssetFlowError::RequestClosed);
    require!(!is_matured(&a.mint), AssetFlowError::AssetMatured);
    require!(!mint_supply_and_paused(&a.mint.to_account_info())?.1, AssetFlowError::MintPaused);
    require!(
        holder_is_eligible(&a.asset.key(), &a.registry, &a.request.holder, &a.investor.to_account_info())?,
        AssetFlowError::NotEligible
    );
    let now = Clock::get()?.unix_timestamp;
    let units = a.request.units;
    let face = principal(a.terms.face_per_unit, units)?;
    let accrued = accrued_interest(&a.terms, units, now)?;
    let amount = face.checked_add(accrued).ok_or(error!(AssetFlowError::MathOverflow))?;

    // Delivery against payment: the cash moves and the units burn together.
    token_interface::transfer_checked(
        CpiContext::new(
            a.currency_program.key(),
            TransferChecked {
                from: a.source.to_account_info(),
                mint: a.currency_mint.to_account_info(),
                to: a.destination.to_account_info(),
                authority: a.issuer.to_account_info(),
            },
        ),
        amount,
        a.currency_mint.decimals,
    )?;
    let mint = a.mint.to_account_info();
    let escrow = a.escrow.to_account_info();
    let token_program = a.token_program.to_account_info();
    open_escrow(a.escrow.is_frozen(), &a.asset, &mint, &escrow, &a.mint_config, &token_program)?;
    burn_as_asset(&a.token_program, &a.mint, &escrow, &a.asset, units)?;
    close_escrow(&a.asset, &mint, &escrow, &a.mint_config, &token_program)?;

    let asset = a.asset.key();
    let request = &mut ctx.accounts.request;
    request.status = RedemptionStatus::Settled;
    request.closed_ts = now;
    request.principal = face;
    request.interest = accrued;
    emit!(RedemptionSettled {
        asset,
        holder: request.holder,
        id: request.id,
        units,
        principal: face,
        interest: accrued,
    });
    Ok(())
}

/// Return a request's units to the holder: to an account of theirs that is
/// frozen, too, which stays frozen.
pub fn return_request(ctx: Context<ReturnRedemption>, status: RedemptionStatus) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.request.status == RedemptionStatus::Requested, AssetFlowError::RequestClosed);
    require!(!mint_supply_and_paused(&a.mint.to_account_info())?.1, AssetFlowError::MintPaused);
    let mint = a.mint.to_account_info();
    let destination = a.destination.to_account_info();
    let token_program = a.token_program.to_account_info();
    let escrow = a.escrow.to_account_info();
    open_escrow(a.escrow.is_frozen(), &a.asset, &mint, &escrow, &a.mint_config, &token_program)?;
    let frozen = a.destination.is_frozen();
    if frozen {
        token_acl_set_frozen(false, &a.asset, &mint, &destination, &a.mint_config, &token_program)?;
    }
    let mint_key = a.mint.key();
    let bump = [a.asset.bump];
    transfer_signed(
        &token_program,
        &escrow,
        &a.mint,
        &destination,
        &a.asset.to_account_info(),
        &asset_seeds(&mint_key, &bump),
        a.request.units,
    )?;
    if frozen {
        token_acl_set_frozen(true, &a.asset, &mint, &destination, &a.mint_config, &token_program)?;
    }
    close_escrow(&a.asset, &mint, &escrow, &a.mint_config, &token_program)?;

    let asset = a.asset.key();
    let request = &mut ctx.accounts.request;
    request.status = status;
    request.closed_ts = Clock::get()?.unix_timestamp;
    emit!(RedemptionReturned {
        asset,
        holder: request.holder,
        id: request.id,
        units: request.units,
        rejected: status == RedemptionStatus::Rejected,
    });
    Ok(())
}

pub fn begin_maturity(ctx: Context<StartMaturity>) -> Result<()> {
    let a = &ctx.accounts;
    let periods = &a.terms.periods;
    let last = periods.last().ok_or(error!(AssetFlowError::InvalidTerms))?;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= last.payment_ts, AssetFlowError::MaturityNotReached);
    // Every coupon's register must be on record first: once units start to
    // burn, a register read later would leave their holders out.
    require!(ctx.remaining_accounts.len() == periods.len(), AssetFlowError::CouponsOutstanding);
    let mint_key = a.mint.key();
    for (i, info) in ctx.remaining_accounts.iter().enumerate() {
        let (expected, _) = Pubkey::find_program_address(&[PAYOUT_SEED, mint_key.as_ref(), &[i as u8]], &crate::ID);
        require!(
            info.key() == expected && info.owner == &crate::ID && !info.data_is_empty(),
            AssetFlowError::CouponsOutstanding
        );
        let payout = Payout::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        require!(payout.status == PayoutStatus::Counted, AssetFlowError::CouponsOutstanding);
    }

    let bump = [a.asset.bump];
    token_interface::set_authority(
        CpiContext::new_with_signer(
            a.token_program.key(),
            SetAuthority { current_authority: a.asset.to_account_info(), account_or_mint: a.mint.to_account_info() },
            &[&asset_seeds(&mint_key, &bump)],
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    let units = a.mint.supply;
    let face_per_unit = a.terms.face_per_unit;
    let required = principal(face_per_unit, units)?;
    let asset = a.asset.key();
    let currency_mint = a.currency_mint.key();
    let maturity = &mut ctx.accounts.maturity;
    maturity.asset = asset;
    maturity.currency_mint = currency_mint;
    maturity.face_per_unit = face_per_unit;
    maturity.started_ts = now;
    maturity.units = units;
    maturity.required = required;
    maturity.bump = ctx.bumps.maturity;
    maturity.vault_bump = ctx.bumps.vault;
    emit!(MaturityStarted { asset, units, required });
    Ok(())
}

pub fn fund_principal(ctx: Context<FundMaturity>, amount: u64) -> Result<()> {
    require!(amount > 0, AssetFlowError::InvalidAmount);
    let a = &ctx.accounts;
    let before = a.vault.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            a.currency_program.key(),
            TransferChecked {
                from: a.source.to_account_info(),
                mint: a.currency_mint.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.funder.to_account_info(),
            },
        ),
        amount,
        a.currency_mint.decimals,
    )?;
    ctx.accounts.vault.reload()?;
    // Counted as what arrived, so a currency that charges a fee cannot inflate it.
    let received = ctx.accounts.vault.amount.checked_sub(before).ok_or(error!(AssetFlowError::MathOverflow))?;
    let maturity = &mut ctx.accounts.maturity;
    maturity.funded = maturity.funded.checked_add(received).ok_or(error!(AssetFlowError::MathOverflow))?;
    emit!(MaturityFunded { asset: maturity.asset, amount: received, funded: maturity.funded });
    Ok(())
}

pub fn redeem_holding(ctx: Context<RedeemAtMaturity>) -> Result<()> {
    let a = &ctx.accounts;
    // All of it or none of it, so the holders redeemed first and last are
    // treated alike.
    require!(a.maturity.funded >= a.maturity.required, AssetFlowError::Underfunded);
    let units = a.holding.amount;
    require!(units > 0, AssetFlowError::InvalidAmount);
    let holder = a.holding.owner;
    require!(
        holder_is_eligible(&a.asset.key(), &a.registry, &holder, &a.investor.to_account_info())?,
        AssetFlowError::NotEligible
    );
    // A holder whose account is frozen but who is eligible can thaw it
    // through the gate first; an account frozen by compliance stays put.
    require!(!a.holding.is_frozen(), AssetFlowError::HoldingFrozen);
    let amount = principal(a.maturity.face_per_unit, units)?;
    let committed = a.maturity.paid.checked_add(amount).ok_or(error!(AssetFlowError::MathOverflow))?;
    require!(committed <= a.maturity.funded, AssetFlowError::Overdrawn);

    burn_as_asset(&a.token_program, &a.mint, &a.holding.to_account_info(), &a.asset, units)?;
    let mint_key = a.mint.key();
    let bump = [a.maturity.bump];
    let seeds: [&[u8]; 3] = [MATURITY_SEED, mint_key.as_ref(), &bump];
    transfer_signed(
        &a.currency_program.to_account_info(),
        &a.vault.to_account_info(),
        &a.currency_mint,
        &a.destination.to_account_info(),
        &a.maturity.to_account_info(),
        &seeds,
        amount,
    )?;

    let maturity_key = a.maturity.key();
    let now = Clock::get()?.unix_timestamp;
    let maturity = &mut ctx.accounts.maturity;
    maturity.paid = committed;
    maturity.units_redeemed += units;
    maturity.redemptions += 1;
    let record = &mut ctx.accounts.record;
    record.maturity = maturity_key;
    record.holder = holder;
    record.units += units;
    record.amount += amount;
    record.ts = now;
    emit!(RedeemedAtMaturity { asset: maturity.asset, holder, units, amount });
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct RequestRedemption<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    /// Redemptions are priced from the terms, so an asset without them has none.
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = holder)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = escrow_address(&asset.key(), &mint.key()))]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: may not exist. A wallet with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), holder.key().as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    #[account(
        init,
        payer = holder,
        space = 8 + RedemptionRequest::INIT_SPACE,
        seeds = [REDEMPTION_SEED, mint.key().as_ref(), holder.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub request: Box<Account<'info, RedemptionRequest>>,
    /// CHECK: Token ACL's config for this mint.
    #[account(seeds = [MINT_CONFIG_SEED, mint.key().as_ref()], bump, seeds::program = token_acl_program.key())]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// The escrow is the asset's associated account for its own mint.
pub fn escrow_address(asset: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(asset, mint, &anchor_spl::token_2022::ID)
}

#[derive(Accounts)]
pub struct SettleRedemption<'info> {
    pub issuer: Signer<'info>,
    #[account(has_one = issuer @ AssetFlowError::Unauthorized, has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = asset)]
    pub request: Box<Account<'info, RedemptionRequest>>,
    #[account(mut, address = escrow_address(&asset.key(), &mint.key()))]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = currency_mint, token::authority = issuer)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = currency_mint,
        constraint = destination.owner == request.holder @ AssetFlowError::WrongDestination
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: may not exist. A holder with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), request.holder.as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    /// CHECK: Token ACL's config for this mint.
    #[account(seeds = [MINT_CONFIG_SEED, mint.key().as_ref()], bump, seeds::program = token_acl_program.key())]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
}

/// Shared by the holder's cancel and the issuer's reject.
#[derive(Accounts)]
pub struct ReturnRedemption<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = asset)]
    pub request: Box<Account<'info, RedemptionRequest>>,
    #[account(mut, address = escrow_address(&asset.key(), &mint.key()))]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        constraint = destination.owner == request.holder @ AssetFlowError::WrongDestination
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Token ACL's config for this mint.
    #[account(seeds = [MINT_CONFIG_SEED, mint.key().as_ref()], bump, seeds::program = token_acl_program.key())]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

/// Remaining accounts: every period's payout, in order.
#[derive(Accounts)]
pub struct StartMaturity<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = caller,
        space = 8 + Maturity::INIT_SPACE,
        seeds = [MATURITY_SEED, mint.key().as_ref()],
        bump
    )]
    pub maturity: Box<Account<'info, Maturity>>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = caller,
        token::mint = currency_mint,
        token::authority = maturity,
        token::token_program = currency_program,
        seeds = [MATURITY_VAULT_SEED, maturity.key().as_ref()],
        bump
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundMaturity<'info> {
    pub funder: Signer<'info>,
    /// CHECK: only names the maturity; that account exists only for a serviced mint.
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [MATURITY_SEED, mint.key().as_ref()], bump = maturity.bump)]
    pub maturity: Box<Account<'info, Maturity>>,
    #[account(address = maturity.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = currency_mint, token::authority = funder)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [MATURITY_VAULT_SEED, maturity.key().as_ref()], bump = maturity.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub currency_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RedeemAtMaturity<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [MATURITY_SEED, mint.key().as_ref()], bump = maturity.bump)]
    pub maturity: Box<Account<'info, Maturity>>,
    #[account(address = maturity.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [MATURITY_VAULT_SEED, maturity.key().as_ref()], bump = maturity.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The asset's own accounts (the escrow) are never a holding: units
    /// waiting there go back to their holder first.
    #[account(mut, token::mint = mint, constraint = holding.owner != asset.key() @ AssetFlowError::NotAHolding)]
    pub holding: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = currency_mint,
        constraint = destination.owner == holding.owner @ AssetFlowError::WrongDestination
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: may not exist. A holder with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), holding.owner.as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + MaturityRecord::INIT_SPACE,
        seeds = [REDEEMED_SEED, maturity.key().as_ref(), holding.owner.as_ref()],
        bump
    )]
    pub record: Box<Account<'info, MaturityRecord>>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct RedemptionRequested {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub id: u32,
    pub units: u64,
}

#[event]
pub struct RedemptionSettled {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub id: u32,
    pub units: u64,
    pub principal: u64,
    pub interest: u64,
}

#[event]
pub struct RedemptionReturned {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub id: u32,
    pub units: u64,
    pub rejected: bool,
}

#[event]
pub struct MaturityStarted {
    pub asset: Pubkey,
    pub units: u64,
    pub required: u64,
}

#[event]
pub struct MaturityFunded {
    pub asset: Pubkey,
    pub amount: u64,
    pub funded: u64,
}

#[event]
pub struct RedeemedAtMaturity {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    pub amount: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coupons::Period;

    const DAY: i64 = 86_400;

    fn ts(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = if m > 2 { m - 3 } else { m + 9 };
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        (era * 146_097 + doe - 719_468) * DAY
    }

    fn bond() -> Terms {
        let p = |s: i64, e: i64| Period { accrual_start: s, accrual_end: e, record_ts: e - 15 * DAY, payment_ts: e };
        Terms {
            asset: Pubkey::default(),
            currency_mint: Pubkey::default(),
            currency_decimals: 6,
            face_per_unit: 1_000_000,
            coupon_bps: 1000,
            periods: vec![p(ts(2026, 10, 1), ts(2027, 4, 1)), p(ts(2027, 4, 1), ts(2027, 10, 1))],
            bump: 0,
        }
    }

    #[test]
    fn interest_accrues_from_the_start_of_the_running_period() {
        // 1 Oct to 1 Jan is 90 days: 10% on US$1,000 for a quarter is US$25.00
        let t = bond();
        assert_eq!(accrued_interest(&t, 1_000, ts(2027, 1, 1) + 3_600).unwrap(), 25_000_000);
        assert_eq!(accrued_interest(&t, 1_000, ts(2026, 10, 1)).unwrap(), 0);
    }

    #[test]
    fn none_accrues_once_the_record_date_has_passed() {
        let t = bond();
        // record date of the first period is 17 Mar 2027; the whole coupon goes to the register
        assert_eq!(accrued_interest(&t, 1_000, ts(2027, 3, 20)).unwrap(), 0);
        // and interest starts again with the next period
        assert_eq!(accrued_interest(&t, 1_000, ts(2027, 5, 1)).unwrap(), 8_330_000);
    }

    #[test]
    fn none_accrues_outside_the_schedule() {
        let t = bond();
        assert_eq!(accrued_interest(&t, 1_000, ts(2026, 9, 1)).unwrap(), 0);
        assert_eq!(accrued_interest(&t, 1_000, ts(2028, 1, 1)).unwrap(), 0);
    }

    #[test]
    fn principal_is_face_times_units() {
        assert_eq!(principal(1_000_000, 2_500).unwrap(), 2_500_000_000);
        assert!(principal(u64::MAX, 2).is_err());
    }
}
