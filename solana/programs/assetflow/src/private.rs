//! Private holdings: units parked in an escrow on Solana, each holder's share
//! kept in an account that lives in a MagicBlock Private Ephemeral Rollup.
//!
//! A holder deposits units on Solana into an escrow the asset account owns,
//! the way a redemption request does. Their share of the escrow is recorded in
//! a holding account that is delegated to the rollup, a validator running in a
//! trusted execution environment. Inside it, AssetFlow's own instructions move
//! units between holdings: the same eligibility rules bind every move, but the
//! balances and the moves can be read only by the holder, the issuer,
//! compliance and an auditor the issuer names. A holder takes units out by
//! withdrawing in the rollup, which settles a public exit ticket on Solana,
//! and then releasing them from the escrow to their own account.
//!
//! What stays public: who has a private holding, every deposit and every
//! release (they are token movements on Solana), and the escrow's total. A
//! holding's balance is never committed to Solana: only exit tickets are.
//!
//! The coupon register counts the escrow as one line. Each private holder's
//! share is fixed lazily: the Solana ledger of a holder records, once the
//! register of a period has been fixed, what the holder had deposited and had
//! released by then; a holding's first move after that records the units it
//! held at the cut. The private shares of a period always add up to the
//! escrow at its fix, so each holder's coupon, rounded down on their own
//! holding, is paid out of the pool's.
//!
//! No instruction that runs in the rollup fails because of a private value:
//! a move asks for at most what is there, and a holding on compliance hold
//! simply does not move. Otherwise a stranger could simulate transactions and
//! read balances from which ones fail.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use ephemeral_rollups_sdk::access_control::instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG,
    TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::coupons::{coupon_amount, mint_supply_and_paused, Payout, Terms, MAX_PERIODS, PAYOUT_SEED, TERMS_SEED};
use crate::redemptions::{asset_seeds, close_escrow, is_matured, open_escrow, transfer_signed};
use crate::{
    holder_is_eligible, token_acl_set_frozen, Asset, AssetFlowError, Registry, INVESTOR_SEED, MINT_CONFIG_SEED,
    TOKEN_ACL_ID,
};

pub const PRIVATE_POOL_SEED: &[u8] = b"private_pool";
pub const PRIVATE_ESCROW_SEED: &[u8] = b"private_escrow";
pub const PRIVATE_CASH_SEED: &[u8] = b"private_cash";
pub const PRIVATE_LEDGER_SEED: &[u8] = b"private_ledger";
pub const PRIVATE_HOLDING_SEED: &[u8] = b"private_holding";
pub const PRIVATE_EXIT_SEED: &[u8] = b"private_exit";

/// MagicBlock's Private Ephemeral Rollup validator (Intel TDX), on devnet and
/// mainnet. Private holdings are delegated to nothing else, so no other
/// rollup can read them or settle their exits.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/// The validator of MagicBlock's local development stack, whose key is
/// public: accepted only by a build for local tests.
#[cfg(feature = "local-rollup")]
pub const LOCAL_VALIDATOR: Pubkey = pubkey!("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

/// Readers of a private holding besides the program: holder, issuer,
/// compliance and the auditor.
const MAX_READERS: usize = 4;

fn allowed_validator(validator: &Pubkey) -> bool {
    #[cfg(feature = "local-rollup")]
    if *validator == LOCAL_VALIDATOR {
        return true;
    }
    *validator == TEE_VALIDATOR
}

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

/// What a holder had deposited and had released when a register was fixed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct CutPoint {
    pub deposited: u64,
    pub released: u64,
}

/// A holder's public record on Solana: what went into and came out of their
/// private holding.
#[account]
#[derive(InitSpace)]
pub struct PrivateLedger {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub deposited: u64,
    pub released: u64,
    pub cash_released: u64,
    /// The first period whose register is not yet recorded here.
    pub next_period: u8,
    pub at_fix: [CutPoint; MAX_PERIODS],
    pub bump: u8,
}

/// A holder's private balance, delegated to the rollup and never committed
/// to Solana while it holds anything.
#[account]
#[derive(InitSpace)]
pub struct PrivateHolding {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    /// Deposits credited so far, out of the ledger's.
    pub credited: u64,
    /// Units withdrawn so far, for release on Solana.
    pub withdrawn: u64,
    /// Coupons credited and not yet withdrawn, in the payment currency.
    pub cash: u64,
    pub cash_withdrawn: u64,
    /// A compliance hold: the holding takes units in but sends none out.
    pub hold: bool,
    /// Its read permission exists; nothing is credited before.
    pub protected: bool,
    /// The first period whose share is not yet recorded here.
    pub next_period: u8,
    /// Bit p set once the coupon of period p was credited.
    pub claimed: u8,
    /// Units the holding was owed a coupon on, per period.
    pub entitled: [u64; MAX_PERIODS],
    pub bump: u8,
}

/// A holder's exit ticket: copies of the holding's cumulative withdrawals,
/// committed to Solana with each exit. Public by design: the units and cash
/// it releases land in the holder's public accounts.
#[account]
#[derive(InitSpace)]
pub struct PrivateExit {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub withdrawn: u64,
    pub cash_withdrawn: u64,
    pub bump: u8,
}

/// Record a holding's share of every register fixed since it last moved:
/// its units then, the deposits it had made and not yet been credited, and
/// the withdrawals not yet released. Reads only what the ledger recorded at
/// each fix, so it gives the same answer however late the rollup sees it.
fn catch_up(holding: &mut PrivateHolding, ledger: &PrivateLedger) -> Result<()> {
    while holding.next_period < ledger.next_period {
        let p = holding.next_period as usize;
        let cut = ledger.at_fix[p];
        let uncredited = cut.deposited.checked_sub(holding.credited).ok_or(error!(AssetFlowError::PrivateLedgerMismatch))?;
        let unreleased = holding.withdrawn.checked_sub(cut.released).ok_or(error!(AssetFlowError::PrivateLedgerMismatch))?;
        holding.entitled[p] = holding
            .units
            .checked_add(uncredited)
            .and_then(|v| v.checked_add(unreleased))
            .ok_or(error!(AssetFlowError::MathOverflow))?;
        holding.next_period += 1;
    }
    Ok(())
}

/// A register fixed but not yet recorded on the ledger stops every move
/// until anyone records it.
fn require_cut_recorded(next_payout: &AccountInfo) -> Result<()> {
    require!(next_payout.data_is_empty(), AssetFlowError::CheckpointRequired);
    Ok(())
}

fn delegation_program_owns(info: &AccountInfo) -> bool {
    info.owner == &ephemeral_rollups_sdk::id()
}

pub fn enable_holdings(ctx: Context<EnablePrivateHoldings>, validator: Pubkey, auditor: Pubkey) -> Result<()> {
    require!(allowed_validator(&validator), AssetFlowError::ValidatorNotAllowed);
    let pool = &mut ctx.accounts.pool;
    pool.asset = ctx.accounts.asset.key();
    pool.validator = validator;
    pool.auditor = auditor;
    pool.escrow = ctx.accounts.escrow.key();
    pool.cash_vault = ctx.accounts.cash_vault.key();
    pool.bump = ctx.bumps.pool;
    pool.escrow_bump = ctx.bumps.escrow;
    pool.cash_bump = ctx.bumps.cash_vault;
    emit!(PrivateHoldingsEnabled { asset: pool.asset, validator, auditor });
    Ok(())
}

pub fn set_auditor(ctx: Context<SetPrivateAuditor>, auditor: Pubkey) -> Result<()> {
    ctx.accounts.pool.auditor = auditor;
    emit!(PrivateAuditorSet { asset: ctx.accounts.pool.asset, auditor });
    Ok(())
}

pub fn open_holding(ctx: Context<OpenPrivate>, next_period: u8) -> Result<()> {
    let a = &ctx.accounts;
    require!(!is_matured(&a.mint), AssetFlowError::AssetMatured);
    require!(
        holder_is_eligible(&a.asset.key(), &a.registry, &a.holder.key(), &a.investor.to_account_info())?,
        AssetFlowError::NotEligible
    );
    // Start at the first register not yet fixed, so a newcomer has no cuts to
    // catch up on.
    require!((next_period as usize) <= a.terms.periods.len(), AssetFlowError::InvalidPeriod);
    require!(next_period == 0 || a.previous.is_some(), AssetFlowError::CheckpointRequired);
    require_cut_recorded(&a.next_payout)?;
    // The holding pays for its own read permission in the rollup.
    transfer(
        CpiContext::new(
            a.system_program.key(),
            Transfer { from: a.holder.to_account_info(), to: a.holding.to_account_info() },
        ),
        ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(MAX_READERS) as u32),
    )?;

    let asset = ctx.accounts.asset.key();
    let holder = ctx.accounts.holder.key();
    let ledger = &mut ctx.accounts.ledger;
    ledger.asset = asset;
    ledger.holder = holder;
    ledger.next_period = next_period;
    ledger.bump = ctx.bumps.ledger;
    let holding = &mut ctx.accounts.holding;
    holding.asset = asset;
    holding.holder = holder;
    holding.next_period = next_period;
    holding.bump = ctx.bumps.holding;
    let exit = &mut ctx.accounts.exit;
    exit.asset = asset;
    exit.holder = holder;
    exit.bump = ctx.bumps.exit;
    emit!(PrivateOpened { asset, holder });
    Ok(())
}

pub fn delegate_holding(ctx: Context<DelegatePrivateHolding>) -> Result<()> {
    require!(!delegation_program_owns(&ctx.accounts.holding), AssetFlowError::PrivateAlreadyDelegated);
    let mint = ctx.accounts.asset.mint;
    let holder = ctx.accounts.holder.key();
    ctx.accounts.delegate_holding(
        &ctx.accounts.holder,
        &[PRIVATE_HOLDING_SEED, mint.as_ref(), holder.as_ref()],
        DelegateConfig { validator: Some(ctx.accounts.pool.validator), ..Default::default() },
    )?;
    Ok(())
}

pub fn delegate_exit(ctx: Context<DelegatePrivateExit>) -> Result<()> {
    require!(!delegation_program_owns(&ctx.accounts.exit), AssetFlowError::PrivateAlreadyDelegated);
    let mint = ctx.accounts.asset.mint;
    let holder = ctx.accounts.holder.key();
    ctx.accounts.delegate_exit(
        &ctx.accounts.holder,
        &[PRIVATE_EXIT_SEED, mint.as_ref(), holder.as_ref()],
        DelegateConfig { validator: Some(ctx.accounts.pool.validator), ..Default::default() },
    )?;
    Ok(())
}

pub fn deposit_units(ctx: Context<DepositPrivate>, units: u64) -> Result<()> {
    require!(units > 0, AssetFlowError::InvalidAmount);
    let a = &ctx.accounts;
    require!(!is_matured(&a.mint), AssetFlowError::AssetMatured);
    require!(!mint_supply_and_paused(&a.mint.to_account_info())?.1, AssetFlowError::MintPaused);
    require_cut_recorded(&a.next_payout)?;
    // Units go in only where the rollup can hold them.
    require!(delegation_program_owns(&a.holding), AssetFlowError::PrivateNotDelegated);
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

    let ledger = &mut ctx.accounts.ledger;
    ledger.deposited = ledger.deposited.checked_add(units).ok_or(error!(AssetFlowError::MathOverflow))?;
    let pool = &mut ctx.accounts.pool;
    pool.total_deposited = pool.total_deposited.checked_add(units).ok_or(error!(AssetFlowError::MathOverflow))?;
    ctx.accounts.escrow.reload()?;
    require_pool_balanced(&ctx.accounts.pool, &ctx.accounts.escrow)?;
    emit!(PrivateDeposited { asset: ctx.accounts.pool.asset, holder: ctx.accounts.holder.key(), units });
    Ok(())
}

fn require_pool_balanced(pool: &PrivatePool, escrow: &InterfaceAccount<TokenAccount>) -> Result<()> {
    let expected = pool.total_deposited.checked_sub(pool.total_released).ok_or(error!(AssetFlowError::MathOverflow))?;
    require!(escrow.amount == expected, AssetFlowError::PrivatePoolMismatch);
    Ok(())
}

pub fn checkpoint_ledger(ctx: Context<CheckpointPrivateLedger>) -> Result<()> {
    let p = ctx.accounts.ledger.next_period as usize;
    require!(p < ctx.accounts.terms.periods.len(), AssetFlowError::InvalidPeriod);
    // The payout account exists (its seeds are p): that register is fixed, and
    // nothing has gone into or out of private holdings since, because every
    // deposit and release first needs this record.
    let ledger = &mut ctx.accounts.ledger;
    ledger.at_fix[p] = CutPoint { deposited: ledger.deposited, released: ledger.released };
    ledger.next_period += 1;
    Ok(())
}

/// Pay units the holder withdrew, and cash they took out of their coupons,
/// from the escrows to their own accounts on Solana.
fn pay_out<'info>(
    a: &mut PayOutAccounts<'_, 'info>,
    holder: Pubkey,
    withdrawn: u64,
    cash_withdrawn: u64,
) -> Result<()> {
    let units = withdrawn.saturating_sub(a.ledger.released);
    if units > 0 {
        require!(!mint_supply_and_paused(&a.mint.to_account_info())?.1, AssetFlowError::MintPaused);
        let mint = a.mint.to_account_info();
        let escrow = a.escrow.to_account_info();
        let destination = a.destination.to_account_info();
        let token_program = a.token_program.to_account_info();
        open_escrow(a.escrow.is_frozen(), a.asset, &mint, &escrow, a.mint_config, &token_program)?;
        // A frozen account takes its units and stays frozen, as a returned
        // redemption does.
        let frozen = a.destination.is_frozen();
        if frozen {
            token_acl_set_frozen(false, a.asset, &mint, &destination, a.mint_config, &token_program)?;
        }
        let mint_key = a.mint.key();
        let bump = [a.asset.bump];
        transfer_signed(&token_program, &escrow, a.mint, &destination, &a.asset.to_account_info(), &asset_seeds(&mint_key, &bump), units)?;
        if frozen {
            token_acl_set_frozen(true, a.asset, &mint, &destination, a.mint_config, &token_program)?;
        }
        close_escrow(a.asset, &mint, &escrow, a.mint_config, &token_program)?;
        a.ledger.released = withdrawn;
        a.pool.total_released = a.pool.total_released.checked_add(units).ok_or(error!(AssetFlowError::MathOverflow))?;
        a.escrow.reload()?;
        require_pool_balanced(a.pool, a.escrow)?;
    }
    let cash = cash_withdrawn.saturating_sub(a.ledger.cash_released);
    // Coupon cash goes only to a holder eligible today; otherwise it waits.
    if cash > 0 && holder_is_eligible(&a.asset.key(), a.registry, &holder, a.investor)? {
        let mint_key = a.mint.key();
        let bump = [a.pool.bump];
        let seeds: [&[u8]; 3] = [PRIVATE_POOL_SEED, mint_key.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.currency_program.key(),
                TransferChecked {
                    from: a.cash_vault.to_account_info(),
                    mint: a.currency_mint.to_account_info(),
                    to: a.cash_destination.to_account_info(),
                    authority: a.pool.to_account_info(),
                },
                &[&seeds],
            ),
            cash,
            a.currency_mint.decimals,
        )?;
        a.ledger.cash_released = cash_withdrawn;
        a.pool.cash_released = a.pool.cash_released.checked_add(cash).ok_or(error!(AssetFlowError::MathOverflow))?;
    }
    let waiting = cash_withdrawn.saturating_sub(a.ledger.cash_released);
    emit!(PrivateReleased { asset: a.asset.key(), holder, units, cash: cash - waiting.min(cash), waiting });
    Ok(())
}

/// The accounts both release paths pay out through.
pub struct PayOutAccounts<'a, 'info> {
    pub asset: &'a Account<'info, Asset>,
    pub registry: &'a Account<'info, Registry>,
    pub investor: &'a AccountInfo<'info>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub pool: &'a mut Account<'info, PrivatePool>,
    pub ledger: &'a mut Account<'info, PrivateLedger>,
    pub escrow: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub destination: &'a InterfaceAccount<'info, TokenAccount>,
    pub currency_mint: &'a InterfaceAccount<'info, Mint>,
    pub cash_vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub cash_destination: &'a InterfaceAccount<'info, TokenAccount>,
    pub mint_config: &'a AccountInfo<'info>,
    pub token_program: &'a Program<'info, Token2022>,
    pub currency_program: &'a Interface<'info, TokenInterface>,
}

pub fn release_exit(mut ctx: Context<ReleasePrivate>) -> Result<()> {
    require_cut_recorded(&ctx.accounts.next_payout)?;
    let holder = ctx.accounts.exit.holder;
    let withdrawn = ctx.accounts.exit.withdrawn;
    let cash_withdrawn = ctx.accounts.exit.cash_withdrawn;
    let a = &mut ctx.accounts;
    let investor = a.investor.to_account_info();
    let mint_config = a.mint_config.to_account_info();
    let mut accounts = PayOutAccounts {
        asset: &a.asset,
        registry: &a.registry,
        investor: &investor,
        mint: &a.mint,
        pool: &mut a.pool,
        ledger: &mut a.ledger,
        escrow: &mut a.escrow,
        destination: &a.destination,
        currency_mint: &a.currency_mint,
        cash_vault: &a.cash_vault,
        cash_destination: &a.cash_destination,
        mint_config: &mint_config,
        token_program: &a.token_program,
        currency_program: &a.currency_program,
    };
    pay_out(&mut accounts, holder, withdrawn, cash_withdrawn)
}

pub fn request_exit(ctx: Context<RequestPrivateExit>) -> Result<()> {
    require!(delegation_program_owns(&ctx.accounts.holding), AssetFlowError::PrivateNotDelegated);
    let mint = ctx.accounts.asset.mint;
    let holder = ctx.accounts.holder.key();
    let bump = [ctx.bumps.holding];
    let seeds: &[&[u8]] = &[PRIVATE_HOLDING_SEED, mint.as_ref(), holder.as_ref(), &bump];
    let ix = ephemeral_rollups_sdk::instruction_builder::request_undelegation(holder, ctx.accounts.holding.key(), crate::ID);
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.holder.to_account_info(),
            ctx.accounts.holding.to_account_info(),
            ctx.accounts.owner_program.to_account_info(),
            ctx.accounts.undelegation_request.to_account_info(),
            ctx.accounts.delegation_record.to_account_info(),
            ctx.accounts.delegation_metadata.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;
    emit!(PrivateExitRequested { asset: ctx.accounts.asset.key(), holder });
    Ok(())
}

pub fn recover_holding(mut ctx: Context<RecoverPrivate>) -> Result<()> {
    require_cut_recorded(&ctx.accounts.next_payout)?;
    // A hold set in the rollup comes back with the holding and still binds.
    require!(!ctx.accounts.holding.hold, AssetFlowError::HoldingOnHold);
    catch_up(&mut ctx.accounts.holding, &ctx.accounts.ledger)?;
    let deposited = ctx.accounts.ledger.deposited;
    let holding = &mut ctx.accounts.holding;
    // Everything the holding owns, credited or not, leaves it.
    let uncredited = deposited.checked_sub(holding.credited).ok_or(error!(AssetFlowError::PrivateLedgerMismatch))?;
    holding.units = holding.units.checked_add(uncredited).ok_or(error!(AssetFlowError::MathOverflow))?;
    holding.credited = deposited;
    holding.withdrawn = holding.withdrawn.checked_add(holding.units).ok_or(error!(AssetFlowError::MathOverflow))?;
    holding.units = 0;
    holding.cash_withdrawn = holding.cash_withdrawn.checked_add(holding.cash).ok_or(error!(AssetFlowError::MathOverflow))?;
    holding.cash = 0;
    let holder = holding.holder;
    let withdrawn = holding.withdrawn;
    let cash_withdrawn = holding.cash_withdrawn;
    let a = &mut ctx.accounts;
    let investor = a.investor.to_account_info();
    let mint_config = a.mint_config.to_account_info();
    let mut accounts = PayOutAccounts {
        asset: &a.asset,
        registry: &a.registry,
        investor: &investor,
        mint: &a.mint,
        pool: &mut a.pool,
        ledger: &mut a.ledger,
        escrow: &mut a.escrow,
        destination: &a.destination,
        currency_mint: &a.currency_mint,
        cash_vault: &a.cash_vault,
        cash_destination: &a.cash_destination,
        mint_config: &mint_config,
        token_program: &a.token_program,
        currency_program: &a.currency_program,
    };
    pay_out(&mut accounts, holder, withdrawn, cash_withdrawn)
}

pub fn protect_holding(ctx: Context<ProtectPrivate>) -> Result<()> {
    let a = &ctx.accounts;
    let mut readers: Vec<Pubkey> = Vec::with_capacity(MAX_READERS);
    for key in [a.holding.holder, a.asset.issuer, a.registry.compliance, a.pool.auditor] {
        if key != Pubkey::default() && !readers.contains(&key) {
            readers.push(key);
        }
    }
    let members = readers
        .into_iter()
        .map(|pubkey| Member { flags: TX_LOGS_FLAG | TX_BALANCES_FLAG | TX_MESSAGE_FLAG, pubkey })
        .collect();
    let mint = a.asset.mint;
    let holder = a.holding.holder;
    let bump = [a.holding.bump];
    let seeds: &[&[u8]] = &[PRIVATE_HOLDING_SEED, mint.as_ref(), holder.as_ref(), &bump];
    let args = EphemeralMembersArgs { is_private: true, members };
    if a.permission.lamports() == 0 {
        CreateEphemeralPermissionCpi {
            payer: a.holding.to_account_info(),
            permissioned_account: a.holding.to_account_info(),
            permission: a.permission.to_account_info(),
            vault: a.ephemeral_vault.to_account_info(),
            magic_program: a.magic_program.to_account_info(),
            permission_program: a.permission_program.to_account_info(),
            args,
        }
        .invoke_signed(&[seeds])?;
    } else {
        // Rebuilt in full, so a rotated compliance key or auditor loses access.
        UpdateEphemeralPermissionCpi {
            payer: a.holding.to_account_info(),
            permissioned_account: a.holding.to_account_info(),
            permission: a.permission.to_account_info(),
            vault: a.ephemeral_vault.to_account_info(),
            magic_program: a.magic_program.to_account_info(),
            permission_program: a.permission_program.to_account_info(),
            authority: a.holding.to_account_info(),
            authority_is_signer: false,
            args,
        }
        .invoke_signed(&[seeds])?;
    }
    ctx.accounts.holding.protected = true;
    Ok(())
}

pub fn credit_deposits(ctx: Context<CreditPrivate>) -> Result<()> {
    require!(ctx.accounts.holding.protected, AssetFlowError::NotProtected);
    catch_up(&mut ctx.accounts.holding, &ctx.accounts.ledger)?;
    require_cut_recorded(&ctx.accounts.next_payout)?;
    let deposited = ctx.accounts.ledger.deposited;
    let holding = &mut ctx.accounts.holding;
    let delta = deposited.checked_sub(holding.credited).ok_or(error!(AssetFlowError::PrivateLedgerMismatch))?;
    holding.units = holding.units.checked_add(delta).ok_or(error!(AssetFlowError::MathOverflow))?;
    holding.credited = deposited;
    Ok(())
}

pub fn transfer_units(ctx: Context<TransferPrivate>, units: u64) -> Result<()> {
    require!(units > 0, AssetFlowError::InvalidAmount);
    let a = &ctx.accounts;
    require_keys_neq!(a.from.key(), a.to.key(), AssetFlowError::InvalidAmount);
    require!(a.from.protected && a.to.protected, AssetFlowError::NotProtected);
    // Both sides of a private move must be eligible today, as both sides of
    // a public transfer must hold thawed accounts.
    let asset = a.asset.key();
    require!(
        holder_is_eligible(&asset, &a.registry, &a.from.holder, &a.from_investor.to_account_info())?,
        AssetFlowError::NotEligible
    );
    require!(
        holder_is_eligible(&asset, &a.registry, &a.to.holder, &a.to_investor.to_account_info())?,
        AssetFlowError::NotEligible
    );
    // Both holdings sit in the same coupon period, so the move changes
    // nobody's share of a register already fixed.
    require!(a.from_ledger.next_period == a.to_ledger.next_period, AssetFlowError::CheckpointRequired);
    catch_up(&mut ctx.accounts.from, &ctx.accounts.from_ledger)?;
    catch_up(&mut ctx.accounts.to, &ctx.accounts.to_ledger)?;
    require_cut_recorded(&ctx.accounts.next_payout)?;
    let from = &mut ctx.accounts.from;
    if from.hold {
        return Ok(());
    }
    let moved = units.min(from.units);
    from.units -= moved;
    let to = &mut ctx.accounts.to;
    to.units = to.units.checked_add(moved).ok_or(error!(AssetFlowError::MathOverflow))?;
    Ok(())
}

pub fn withdraw_units(ctx: Context<WithdrawPrivate>, units: u64, cash: u64) -> Result<()> {
    catch_up(&mut ctx.accounts.holding, &ctx.accounts.ledger)?;
    require_cut_recorded(&ctx.accounts.next_payout)?;
    let holding = &mut ctx.accounts.holding;
    if !holding.hold {
        let units = units.min(holding.units);
        let cash = cash.min(holding.cash);
        holding.units -= units;
        holding.withdrawn = holding.withdrawn.checked_add(units).ok_or(error!(AssetFlowError::MathOverflow))?;
        holding.cash -= cash;
        holding.cash_withdrawn = holding.cash_withdrawn.checked_add(cash).ok_or(error!(AssetFlowError::MathOverflow))?;
    }
    let withdrawn = holding.withdrawn;
    let cash_withdrawn = holding.cash_withdrawn;
    // The ticket is written before the commit is scheduled: the commit takes
    // the bytes as they are at that moment.
    let exit = &mut ctx.accounts.exit;
    exit.withdrawn = withdrawn;
    exit.cash_withdrawn = cash_withdrawn;
    exit.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.holder.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.exit.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

pub fn claim_coupon(ctx: Context<ClaimPrivateCoupon>, period: u8) -> Result<()> {
    require!(ctx.accounts.payout.private_paid, AssetFlowError::WrongPayoutStatus);
    catch_up(&mut ctx.accounts.holding, &ctx.accounts.ledger)?;
    require_cut_recorded(&ctx.accounts.next_payout)?;
    let schedule = *ctx.accounts.terms.periods.get(period as usize).ok_or(error!(AssetFlowError::InvalidPeriod))?;
    let holding = &mut ctx.accounts.holding;
    // The holding is caught up past every counted register (the ledger
    // recorded this one before the pool's coupon could be paid).
    require!(period < holding.next_period, AssetFlowError::CheckpointRequired);
    let bit = 1u8 << period;
    if holding.claimed & bit != 0 {
        return Ok(());
    }
    let amount = coupon_amount(&ctx.accounts.terms, &schedule, holding.entitled[period as usize])?;
    holding.cash = holding.cash.checked_add(amount).ok_or(error!(AssetFlowError::MathOverflow))?;
    holding.claimed |= bit;
    Ok(())
}

pub fn set_hold(ctx: Context<HoldPrivate>, hold: bool) -> Result<()> {
    ctx.accounts.holding.hold = hold;
    Ok(())
}

#[derive(Accounts)]
pub struct EnablePrivateHoldings<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(has_one = issuer @ AssetFlowError::Unauthorized, has_one = mint)]
    pub asset: Box<Account<'info, Asset>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Coupons are paid in the terms' currency, so the terms come first.
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    #[account(address = terms.currency_mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = issuer,
        space = 8 + PrivatePool::INIT_SPACE,
        seeds = [PRIVATE_POOL_SEED, mint.key().as_ref()],
        bump
    )]
    pub pool: Box<Account<'info, PrivatePool>>,
    /// Owned by the asset account and born frozen, like the redemption escrow.
    #[account(
        init,
        payer = issuer,
        token::mint = mint,
        token::authority = asset,
        token::token_program = token_program,
        seeds = [PRIVATE_ESCROW_SEED, mint.key().as_ref()],
        bump
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = issuer,
        token::mint = currency_mint,
        token::authority = pool,
        token::token_program = currency_program,
        seeds = [PRIVATE_CASH_SEED, mint.key().as_ref()],
        bump
    )]
    pub cash_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrivateAuditor<'info> {
    pub issuer: Signer<'info>,
    #[account(has_one = issuer @ AssetFlowError::Unauthorized)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(mut, seeds = [PRIVATE_POOL_SEED, asset.mint.as_ref()], bump = pool.bump, has_one = asset)]
    pub pool: Box<Account<'info, PrivatePool>>,
}

#[derive(Accounts)]
#[instruction(next_period: u8)]
pub struct OpenPrivate<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    /// CHECK: may not exist. A wallet with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), holder.key().as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [TERMS_SEED, mint.key().as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    #[account(seeds = [PRIVATE_POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = asset)]
    pub pool: Box<Account<'info, PrivatePool>>,
    /// The last register already fixed, when there is one.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref(), &[next_period.saturating_sub(1)]], bump = previous.bump)]
    pub previous: Option<Box<Account<'info, Payout>>>,
    /// CHECK: must not exist: the first register not yet fixed.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref(), &[next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
    #[account(
        init,
        payer = holder,
        space = 8 + PrivateLedger::INIT_SPACE,
        seeds = [PRIVATE_LEDGER_SEED, mint.key().as_ref(), holder.key().as_ref()],
        bump
    )]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    #[account(
        init,
        payer = holder,
        space = 8 + PrivateHolding::INIT_SPACE,
        seeds = [PRIVATE_HOLDING_SEED, mint.key().as_ref(), holder.key().as_ref()],
        bump
    )]
    pub holding: Box<Account<'info, PrivateHolding>>,
    #[account(
        init,
        payer = holder,
        space = 8 + PrivateExit::INIT_SPACE,
        seeds = [PRIVATE_EXIT_SEED, mint.key().as_ref(), holder.key().as_ref()],
        bump
    )]
    pub exit: Box<Account<'info, PrivateExit>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePrivateHolding<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [PRIVATE_POOL_SEED, asset.mint.as_ref()], bump = pool.bump, has_one = asset)]
    pub pool: Box<Account<'info, PrivatePool>>,
    /// CHECK: the holder's holding; delegated here.
    #[account(mut, del, seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), holder.key().as_ref()], bump)]
    pub holding: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePrivateExit<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [PRIVATE_POOL_SEED, asset.mint.as_ref()], bump = pool.bump, has_one = asset)]
    pub pool: Box<Account<'info, PrivatePool>>,
    /// CHECK: the holder's exit ticket; delegated here.
    #[account(mut, del, seeds = [PRIVATE_EXIT_SEED, asset.mint.as_ref(), holder.key().as_ref()], bump)]
    pub exit: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositPrivate<'info> {
    pub holder: Signer<'info>,
    #[account(has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    /// CHECK: may not exist. A wallet with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), holder.key().as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [PRIVATE_POOL_SEED, mint.key().as_ref()], bump = pool.bump, has_one = asset, has_one = escrow)]
    pub pool: Box<Account<'info, PrivatePool>>,
    #[account(mut, seeds = [PRIVATE_LEDGER_SEED, mint.key().as_ref(), holder.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    /// CHECK: must not exist: a fixed register is recorded on the ledger first.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref(), &[ledger.next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
    /// CHECK: the holder's holding; must be in the rollup.
    #[account(seeds = [PRIVATE_HOLDING_SEED, mint.key().as_ref(), holder.key().as_ref()], bump)]
    pub holding: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = holder)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Token ACL's config for this mint.
    #[account(seeds = [MINT_CONFIG_SEED, mint.key().as_ref()], bump, seeds::program = token_acl_program.key())]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct CheckpointPrivateLedger<'info> {
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [TERMS_SEED, asset.mint.as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    #[account(mut, seeds = [PRIVATE_LEDGER_SEED, asset.mint.as_ref(), ledger.holder.as_ref()], bump = ledger.bump, has_one = asset)]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    /// The register the ledger records: it must exist, so it has been fixed.
    #[account(seeds = [PAYOUT_SEED, asset.mint.as_ref(), &[ledger.next_period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
}

#[derive(Accounts)]
pub struct ReleasePrivate<'info> {
    #[account(has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    /// CHECK: may not exist. A holder with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), exit.holder.as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [PRIVATE_POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
        has_one = asset,
        has_one = escrow,
        has_one = cash_vault
    )]
    pub pool: Box<Account<'info, PrivatePool>>,
    #[account(mut, seeds = [PRIVATE_LEDGER_SEED, mint.key().as_ref(), exit.holder.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    /// CHECK: must not exist: a fixed register is recorded on the ledger first.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref(), &[ledger.next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
    /// Settled on Solana: a ticket still in the rollup is owned by the
    /// delegation program and refused here.
    #[account(seeds = [PRIVATE_EXIT_SEED, mint.key().as_ref(), exit.holder.as_ref()], bump = exit.bump, has_one = asset)]
    pub exit: Box<Account<'info, PrivateExit>>,
    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.owner == exit.holder @ AssetFlowError::WrongDestination
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub cash_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = cash_vault.mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = currency_mint,
        constraint = cash_destination.owner == exit.holder @ AssetFlowError::WrongDestination
    )]
    pub cash_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Token ACL's config for this mint.
    #[account(seeds = [MINT_CONFIG_SEED, mint.key().as_ref()], bump, seeds::program = token_acl_program.key())]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RequestPrivateExit<'info> {
    /// Paid for the holding's delegation, which makes them the only one the
    /// delegation program takes this request from.
    #[account(mut)]
    pub holder: Signer<'info>,
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: the holder's holding, in the rollup.
    #[account(seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), holder.key().as_ref()], bump)]
    pub holding: UncheckedAccount<'info>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub owner_program: UncheckedAccount<'info>,
    /// CHECK: the delegation program's undelegation request for the holding.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::UNDELEGATION_REQUEST_TAG, holding.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub undelegation_request: UncheckedAccount<'info>,
    /// CHECK: the delegation program's record of the holding.
    #[account(
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_RECORD_TAG, holding.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub delegation_record: UncheckedAccount<'info>,
    /// CHECK: the delegation program's metadata of the holding.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_METADATA_TAG, holding.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub delegation_metadata: UncheckedAccount<'info>,
    /// CHECK: the delegation program.
    #[account(address = ephemeral_rollups_sdk::id())]
    pub delegation_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecoverPrivate<'info> {
    #[account(has_one = mint, has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    /// CHECK: may not exist. A holder with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), holding.holder.as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [PRIVATE_POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
        has_one = asset,
        has_one = escrow,
        has_one = cash_vault
    )]
    pub pool: Box<Account<'info, PrivatePool>>,
    #[account(mut, seeds = [PRIVATE_LEDGER_SEED, mint.key().as_ref(), holding.holder.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    /// CHECK: must not exist: a fixed register is recorded on the ledger first.
    #[account(seeds = [PAYOUT_SEED, mint.key().as_ref(), &[ledger.next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
    /// Back on Solana: a holding still in the rollup is owned by the
    /// delegation program and refused here.
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, mint.key().as_ref(), holding.holder.as_ref()],
        bump = holding.bump,
        has_one = asset
    )]
    pub holding: Box<Account<'info, PrivateHolding>>,
    #[account(mut)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.owner == holding.holder @ AssetFlowError::WrongDestination
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub cash_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = cash_vault.mint)]
    pub currency_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = currency_mint,
        constraint = cash_destination.owner == holding.holder @ AssetFlowError::WrongDestination
    )]
    pub cash_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Token ACL's config for this mint.
    #[account(seeds = [MINT_CONFIG_SEED, mint.key().as_ref()], bump, seeds::program = token_acl_program.key())]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub currency_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ProtectPrivate<'info> {
    #[account(has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    #[account(seeds = [PRIVATE_POOL_SEED, asset.mint.as_ref()], bump = pool.bump, has_one = asset)]
    pub pool: Box<Account<'info, PrivatePool>>,
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), holding.holder.as_ref()],
        bump = holding.bump,
        has_one = asset
    )]
    pub holding: Box<Account<'info, PrivateHolding>>,
    /// CHECK: the holding's read permission, created or rebuilt here.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, holding.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock's permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: the rollup's vault for ephemeral rent.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: the rollup's magic program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreditPrivate<'info> {
    pub asset: Box<Account<'info, Asset>>,
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), holding.holder.as_ref()],
        bump = holding.bump,
        has_one = asset
    )]
    pub holding: Box<Account<'info, PrivateHolding>>,
    #[account(seeds = [PRIVATE_LEDGER_SEED, asset.mint.as_ref(), holding.holder.as_ref()], bump = ledger.bump, has_one = asset)]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    /// CHECK: must not exist: a fixed register is recorded on the ledger first.
    #[account(seeds = [PAYOUT_SEED, asset.mint.as_ref(), &[ledger.next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TransferPrivate<'info> {
    pub sender: Signer<'info>,
    #[account(has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    pub registry: Box<Account<'info, Registry>>,
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), sender.key().as_ref()],
        bump = from.bump,
        has_one = asset
    )]
    pub from: Box<Account<'info, PrivateHolding>>,
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), to.holder.as_ref()],
        bump = to.bump,
        has_one = asset
    )]
    pub to: Box<Account<'info, PrivateHolding>>,
    #[account(seeds = [PRIVATE_LEDGER_SEED, asset.mint.as_ref(), sender.key().as_ref()], bump = from_ledger.bump, has_one = asset)]
    pub from_ledger: Box<Account<'info, PrivateLedger>>,
    #[account(seeds = [PRIVATE_LEDGER_SEED, asset.mint.as_ref(), to.holder.as_ref()], bump = to_ledger.bump, has_one = asset)]
    pub to_ledger: Box<Account<'info, PrivateLedger>>,
    /// CHECK: may not exist. A wallet with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), sender.key().as_ref()], bump)]
    pub from_investor: UncheckedAccount<'info>,
    /// CHECK: may not exist. A wallet with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), to.holder.as_ref()], bump)]
    pub to_investor: UncheckedAccount<'info>,
    /// CHECK: must not exist: a fixed register is recorded on the ledger first.
    #[account(seeds = [PAYOUT_SEED, asset.mint.as_ref(), &[from_ledger.next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct WithdrawPrivate<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    pub asset: Box<Account<'info, Asset>>,
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), holder.key().as_ref()],
        bump = holding.bump,
        has_one = asset
    )]
    pub holding: Box<Account<'info, PrivateHolding>>,
    #[account(
        mut,
        seeds = [PRIVATE_EXIT_SEED, asset.mint.as_ref(), holder.key().as_ref()],
        bump = exit.bump,
        has_one = asset
    )]
    pub exit: Box<Account<'info, PrivateExit>>,
    #[account(seeds = [PRIVATE_LEDGER_SEED, asset.mint.as_ref(), holder.key().as_ref()], bump = ledger.bump, has_one = asset)]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    /// CHECK: must not exist: a fixed register is recorded on the ledger first.
    #[account(seeds = [PAYOUT_SEED, asset.mint.as_ref(), &[ledger.next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(period: u8)]
pub struct ClaimPrivateCoupon<'info> {
    pub asset: Box<Account<'info, Asset>>,
    #[account(seeds = [TERMS_SEED, asset.mint.as_ref()], bump = terms.bump, has_one = asset)]
    pub terms: Box<Account<'info, Terms>>,
    #[account(seeds = [PAYOUT_SEED, asset.mint.as_ref(), &[period]], bump = payout.bump)]
    pub payout: Box<Account<'info, Payout>>,
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), holding.holder.as_ref()],
        bump = holding.bump,
        has_one = asset
    )]
    pub holding: Box<Account<'info, PrivateHolding>>,
    #[account(seeds = [PRIVATE_LEDGER_SEED, asset.mint.as_ref(), holding.holder.as_ref()], bump = ledger.bump, has_one = asset)]
    pub ledger: Box<Account<'info, PrivateLedger>>,
    /// CHECK: must not exist: a fixed register is recorded on the ledger first.
    #[account(seeds = [PAYOUT_SEED, asset.mint.as_ref(), &[ledger.next_period]], bump)]
    pub next_payout: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct HoldPrivate<'info> {
    pub compliance: Signer<'info>,
    #[account(has_one = registry)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(has_one = compliance @ AssetFlowError::Unauthorized)]
    pub registry: Box<Account<'info, Registry>>,
    #[account(
        mut,
        seeds = [PRIVATE_HOLDING_SEED, asset.mint.as_ref(), holding.holder.as_ref()],
        bump = holding.bump,
        has_one = asset
    )]
    pub holding: Box<Account<'info, PrivateHolding>>,
}

#[event]
pub struct PrivateHoldingsEnabled {
    pub asset: Pubkey,
    pub validator: Pubkey,
    pub auditor: Pubkey,
}

#[event]
pub struct PrivateAuditorSet {
    pub asset: Pubkey,
    pub auditor: Pubkey,
}

#[event]
pub struct PrivateOpened {
    pub asset: Pubkey,
    pub holder: Pubkey,
}

#[event]
pub struct PrivateDeposited {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
}

#[event]
pub struct PrivateReleased {
    pub asset: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    pub cash: u64,
    /// Coupon cash still waiting for the holder to be eligible.
    pub waiting: u64,
}

#[event]
pub struct PrivateExitRequested {
    pub asset: Pubkey,
    pub holder: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holding() -> PrivateHolding {
        PrivateHolding {
            asset: Pubkey::default(),
            holder: Pubkey::default(),
            units: 0,
            credited: 0,
            withdrawn: 0,
            cash: 0,
            cash_withdrawn: 0,
            hold: false,
            protected: true,
            next_period: 0,
            claimed: 0,
            entitled: [0; MAX_PERIODS],
            bump: 0,
        }
    }

    fn ledger() -> PrivateLedger {
        PrivateLedger {
            asset: Pubkey::default(),
            holder: Pubkey::default(),
            deposited: 0,
            released: 0,
            cash_released: 0,
            next_period: 0,
            at_fix: [CutPoint::default(); MAX_PERIODS],
            bump: 0,
        }
    }

    #[test]
    fn a_deposit_not_yet_credited_and_an_exit_not_yet_released_still_count_to_the_holder() {
        // Deposited 100 and credited it; withdrew 40, of which 10 released;
        // then deposited 50 more, not yet credited, before the fix.
        let mut h = holding();
        h.units = 60;
        h.credited = 100;
        h.withdrawn = 40;
        let mut l = ledger();
        l.at_fix[0] = CutPoint { deposited: 150, released: 10 };
        l.next_period = 1;
        catch_up(&mut h, &l).unwrap();
        assert_eq!(h.entitled[0], 60 + 50 + 30);
        assert_eq!(h.next_period, 1);
    }

    #[test]
    fn shares_add_up_to_the_escrow_at_the_fix_whatever_moved_inside() {
        // Two holders deposit 100 and 50; A sends 30 to B privately; A
        // withdraws 20, released before the fix; B withdraws 10, not yet
        // released. Escrow at the fix: 150 - 20 = 130.
        let (mut a, mut b) = (holding(), holding());
        a.credited = 100;
        a.units = 100 - 30 - 20;
        a.withdrawn = 20;
        b.credited = 50;
        b.units = 50 + 30 - 10;
        b.withdrawn = 10;
        let (mut la, mut lb) = (ledger(), ledger());
        la.at_fix[0] = CutPoint { deposited: 100, released: 20 };
        lb.at_fix[0] = CutPoint { deposited: 50, released: 0 };
        la.next_period = 1;
        lb.next_period = 1;
        catch_up(&mut a, &la).unwrap();
        catch_up(&mut b, &lb).unwrap();
        assert_eq!(a.entitled[0] + b.entitled[0], 130);
    }

    #[test]
    fn a_holding_idle_for_several_registers_catches_up_on_each() {
        let mut h = holding();
        h.units = 70;
        h.credited = 70;
        let mut l = ledger();
        l.at_fix[0] = CutPoint { deposited: 70, released: 0 };
        l.at_fix[1] = CutPoint { deposited: 90, released: 0 };
        l.next_period = 2;
        catch_up(&mut h, &l).unwrap();
        assert_eq!(h.entitled[..2], [70, 90]);
        assert_eq!(h.next_period, 2);
    }

    #[test]
    fn a_ledger_that_contradicts_the_holding_is_refused_not_rounded() {
        // credited more than the ledger says was deposited by the fix
        let mut h = holding();
        h.credited = 120;
        let mut l = ledger();
        l.at_fix[0] = CutPoint { deposited: 100, released: 0 };
        l.next_period = 1;
        assert!(catch_up(&mut h, &l).is_err());
    }
}
