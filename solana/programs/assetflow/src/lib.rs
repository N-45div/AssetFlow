//! AssetFlow on Solana: the servicing layer for a tokenized asset.
//!
//! Eligibility is enforced through Token ACL (sRFC-37), not a transfer hook.
//! Every holder account of an AssetFlow mint starts frozen (Default Account
//! State). Token ACL holds the mint's freeze authority and, before it thaws or
//! freezes an account on anyone's request, asks this program, the mint's gate,
//! whether that is allowed. A plain transfer then runs none of our code, so
//! every wallet and program that handles Token-2022 handles the asset.
//!
//! What that costs: freeze state is static. A wallet whose approval lapses
//! keeps its thawed account until someone freezes it, and anyone may, because
//! the gate approves a permissionless freeze exactly when the holder is no
//! longer eligible. A transfer hook would refuse the next transfer on its own;
//! here enforcement waits for that freeze.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, pubkey_data::PubkeyData, seeds::Seed, state::ExtraAccountMetaList,
};

declare_id!("BWDCF6dLYETPYquDGKm8X6pyLnMZGhisporuTbozjtwR");

pub const REGISTRY_SEED: &[u8] = b"registry";
pub const INVESTOR_SEED: &[u8] = b"investor";
pub const ASSET_SEED: &[u8] = b"asset";
/// Where Token ACL looks for a gate's extra-account lists, one per question.
pub const THAW_EXTRA_METAS_SEED: &[u8] = b"thaw_extra_account_metas";
pub const FREEZE_EXTRA_METAS_SEED: &[u8] = b"freeze_extra_account_metas";

pub const MAX_JURISDICTIONS: usize = 32;
/// Accounts the gate needs beyond the five Token ACL always passes.
const GATE_EXTRA_ACCOUNTS: usize = 3;

/// The two questions Token ACL asks a gate, named by the sRFC-37 standard.
#[derive(SplDiscriminate)]
#[discriminator_hash_input("efficient-allow-block-list-standard:can-thaw-permissionless")]
pub struct ThawQuestion;

#[derive(SplDiscriminate)]
#[discriminator_hash_input("efficient-allow-block-list-standard:can-freeze-permissionless")]
pub struct FreezeQuestion;

#[program]
pub mod assetflow {
    use super::*;

    /// A registry holds the compliance policy and the investor profiles that
    /// one or more assets are gated by. The admin starts as its compliance
    /// officer.
    pub fn create_registry(
        ctx: Context<CreateRegistry>,
        min_tier: u8,
        require_accredited: bool,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.admin = ctx.accounts.admin.key();
        registry.compliance = ctx.accounts.admin.key();
        registry.min_tier = min_tier;
        registry.require_accredited = require_accredited;
        registry.jurisdictions = Vec::new();
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Allow or disallow an ISO 3166-1 numeric jurisdiction.
    pub fn set_jurisdiction(ctx: Context<Compliance>, code: u16, allowed: bool) -> Result<()> {
        let list = &mut ctx.accounts.registry.jurisdictions;
        match (allowed, list.iter().position(|c| *c == code)) {
            (true, None) => {
                require!(list.len() < MAX_JURISDICTIONS, AssetFlowError::TooManyJurisdictions);
                list.push(code);
            }
            (false, Some(at)) => {
                list.swap_remove(at);
            }
            _ => {}
        }
        emit!(JurisdictionUpdated { registry: ctx.accounts.registry.key(), code, allowed });
        Ok(())
    }

    pub fn set_policy(ctx: Context<Compliance>, min_tier: u8, require_accredited: bool) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.min_tier = min_tier;
        registry.require_accredited = require_accredited;
        Ok(())
    }

    /// Create or overwrite a wallet's profile. Changing a profile does not by
    /// itself freeze or thaw anything already held: the gate reads the new
    /// profile the next time anyone asks Token ACL to thaw or freeze.
    pub fn set_investor_profile(
        ctx: Context<SetInvestorProfile>,
        wallet: Pubkey,
        terms: ProfileTerms,
    ) -> Result<()> {
        let profile = &mut ctx.accounts.investor;
        profile.registry = ctx.accounts.registry.key();
        profile.wallet = wallet;
        profile.approved = terms.approved;
        profile.accredited = terms.accredited;
        profile.frozen = terms.frozen;
        profile.tier = terms.tier;
        profile.jurisdiction = terms.jurisdiction;
        profile.expiry = terms.expiry;
        profile.bump = ctx.bumps.investor;
        emit!(InvestorProfileUpdated { registry: profile.registry, wallet, terms });
        Ok(())
    }

    /// Put a mint under AssetFlow servicing. Its mint authority must already
    /// be the asset account, so every unit that ever exists was issued here.
    pub fn register_asset(ctx: Context<RegisterAsset>) -> Result<()> {
        let asset_key = ctx.accounts.asset.key();
        require!(
            ctx.accounts.mint.mint_authority == COption::Some(asset_key),
            AssetFlowError::MintAuthorityNotAsset
        );
        let asset = &mut ctx.accounts.asset;
        asset.registry = ctx.accounts.registry.key();
        asset.mint = ctx.accounts.mint.key();
        asset.issuer = ctx.accounts.admin.key();
        asset.bump = ctx.bumps.asset;
        Ok(())
    }

    /// Write the lists Token ACL uses to find the gate's extra accounts. Both
    /// questions need the same three: the asset, its registry, and the
    /// holder's profile in that registry.
    pub fn initialize_gate(ctx: Context<InitializeGate>) -> Result<()> {
        let metas = gate_extra_metas()?;
        ExtraAccountMetaList::init::<ThawQuestion>(
            &mut ctx.accounts.thaw_metas.try_borrow_mut_data()?[..],
            &metas,
        )?;
        ExtraAccountMetaList::init::<FreezeQuestion>(
            &mut ctx.accounts.freeze_metas.try_borrow_mut_data()?[..],
            &metas,
        )?;
        Ok(())
    }

    /// Issue units. The destination must already be thawed, which means its
    /// owner passed the gate: Token-2022 refuses to mint into a frozen account.
    pub fn issue(ctx: Context<Issue>, amount: u64) -> Result<()> {
        require!(amount > 0, AssetFlowError::InvalidAmount);
        let mint = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[ASSET_SEED, mint.as_ref(), &[ctx.accounts.asset.bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.asset.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    /// Token ACL asks this before a permissionless thaw: yes only if the
    /// account's owner is eligible today.
    #[instruction(discriminator = ThawQuestion::SPL_DISCRIMINATOR_SLICE)]
    pub fn can_thaw_permissionless(ctx: Context<GateCheck>) -> Result<()> {
        require!(ctx.accounts.owner_is_eligible()?, AssetFlowError::NotEligible);
        Ok(())
    }

    /// Token ACL asks this before a permissionless freeze: yes only if the
    /// owner is no longer eligible, so anyone can enforce a lapsed approval
    /// and no one can freeze a holder in good standing.
    #[instruction(discriminator = FreezeQuestion::SPL_DISCRIMINATOR_SLICE)]
    pub fn can_freeze_permissionless(ctx: Context<GateCheck>) -> Result<()> {
        require!(!ctx.accounts.owner_is_eligible()?, AssetFlowError::StillEligible);
        Ok(())
    }
}

/// Token ACL calls the gate with five accounts: [0] caller, [1] token account,
/// [2] mint, [3] token-account owner, [4] its flag account, then [5] the list
/// itself. These resolve the rest from those.
fn gate_extra_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![
        // [6] asset = PDA [ASSET_SEED, mint]
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: ASSET_SEED.to_vec() }, Seed::AccountKey { index: 2 }],
            false,
            false,
        )?,
        // [7] registry, read out of the asset (its first field, after Anchor's
        // 8-byte discriminator)
        ExtraAccountMeta::new_with_pubkey_data(
            &PubkeyData::AccountData { account_index: 6, data_index: 8 },
            false,
            false,
        )?,
        // [8] investor profile = PDA [INVESTOR_SEED, registry, owner]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: INVESTOR_SEED.to_vec() },
                Seed::AccountKey { index: 7 },
                Seed::AccountKey { index: 3 },
            ],
            false,
            false,
        )?,
    ])
}

#[derive(Accounts)]
pub struct CreateRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED, admin.key().as_ref()],
        bump
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Compliance<'info> {
    pub compliance: Signer<'info>,
    #[account(mut, has_one = compliance @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct SetInvestorProfile<'info> {
    #[account(mut)]
    pub compliance: Signer<'info>,
    #[account(has_one = compliance @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
    #[account(
        init_if_needed,
        payer = compliance,
        space = 8 + InvestorProfile::INIT_SPACE,
        seeds = [INVESTOR_SEED, registry.key().as_ref(), wallet.as_ref()],
        bump
    )]
    pub investor: Account<'info, InvestorProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(has_one = admin @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Asset::INIT_SPACE,
        seeds = [ASSET_SEED, mint.key().as_ref()],
        bump
    )]
    pub asset: Account<'info, Asset>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeGate<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(has_one = issuer @ AssetFlowError::Unauthorized, has_one = mint)]
    pub asset: Account<'info, Asset>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: created here and written as an ExtraAccountMetaList.
    #[account(
        init,
        payer = issuer,
        space = ExtraAccountMetaList::size_of(GATE_EXTRA_ACCOUNTS).unwrap(),
        seeds = [THAW_EXTRA_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub thaw_metas: UncheckedAccount<'info>,
    /// CHECK: created here and written as an ExtraAccountMetaList.
    #[account(
        init,
        payer = issuer,
        space = ExtraAccountMetaList::size_of(GATE_EXTRA_ACCOUNTS).unwrap(),
        seeds = [FREEZE_EXTRA_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub freeze_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Issue<'info> {
    pub issuer: Signer<'info>,
    #[account(has_one = issuer @ AssetFlowError::Unauthorized, has_one = mint)]
    pub asset: Account<'info, Asset>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The account order Token ACL uses when it asks a gate either question.
#[derive(Accounts)]
pub struct GateCheck<'info> {
    /// CHECK: whoever asked Token ACL; the answer does not depend on who asks.
    pub caller: UncheckedAccount<'info>,
    /// CHECK: Token ACL has already matched its owner to `owner`.
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: bound to the asset through the asset's seeds.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the wallet whose eligibility is being asked about.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: Token ACL's flag; the gate has no side effects, so it is not read.
    pub flag_account: UncheckedAccount<'info>,
    /// CHECK: this program's extra-metas list, already used by Token ACL.
    pub extra_metas: UncheckedAccount<'info>,
    #[account(seeds = [ASSET_SEED, mint.key().as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,
    #[account(address = asset.registry)]
    pub registry: Account<'info, Registry>,
    /// CHECK: may not exist. A wallet with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), owner.key().as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
}

impl GateCheck<'_> {
    fn owner_is_eligible(&self) -> Result<bool> {
        // Accounts the asset itself owns (payout and redemption vaults) are
        // servicing counterparties, never investors.
        if self.owner.key() == self.asset.key() {
            return Ok(true);
        }
        let info = self.investor.to_account_info();
        if info.owner != &crate::ID || info.data_is_empty() {
            return Ok(false);
        }
        let profile = InvestorProfile::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        Ok(self.registry.admits(&profile, Clock::get()?.unix_timestamp))
    }
}

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub admin: Pubkey,
    pub compliance: Pubkey,
    pub min_tier: u8,
    pub require_accredited: bool,
    #[max_len(32)]
    pub jurisdictions: Vec<u16>,
    pub bump: u8,
}

impl Registry {
    /// The same rule the EVM ComplianceRegistry applied in isWalletEligible.
    pub fn admits(&self, profile: &InvestorProfile, now: i64) -> bool {
        profile.approved
            && !profile.frozen
            && profile.expiry >= now
            && profile.tier >= self.min_tier
            && self.jurisdictions.contains(&profile.jurisdiction)
            && (!self.require_accredited || profile.accredited)
    }
}

#[account]
#[derive(InitSpace)]
pub struct InvestorProfile {
    pub registry: Pubkey,
    pub wallet: Pubkey,
    pub approved: bool,
    pub accredited: bool,
    pub frozen: bool,
    pub tier: u8,
    pub jurisdiction: u16,
    pub expiry: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Asset {
    /// First on purpose: the gate's extra-metas list reads it at byte 8.
    pub registry: Pubkey,
    pub mint: Pubkey,
    pub issuer: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ProfileTerms {
    pub approved: bool,
    pub accredited: bool,
    pub frozen: bool,
    pub tier: u8,
    pub jurisdiction: u16,
    pub expiry: i64,
}

#[event]
pub struct JurisdictionUpdated {
    pub registry: Pubkey,
    pub code: u16,
    pub allowed: bool,
}

#[event]
pub struct InvestorProfileUpdated {
    pub registry: Pubkey,
    pub wallet: Pubkey,
    pub terms: ProfileTerms,
}

#[error_code]
pub enum AssetFlowError {
    #[msg("signer does not hold this role")]
    Unauthorized,
    #[msg("wallet is not eligible to hold this asset")]
    NotEligible,
    #[msg("wallet is still eligible; it cannot be frozen permissionlessly")]
    StillEligible,
    #[msg("jurisdiction list is full")]
    TooManyJurisdictions,
    #[msg("amount must be greater than zero")]
    InvalidAmount,
    #[msg("the mint's authority must be the asset account")]
    MintAuthorityNotAsset,
}
