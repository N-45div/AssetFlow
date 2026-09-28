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
//!
//! Every authority over the mint (mint, permanent delegate, pause, and Token
//! ACL's own freeze authority) is the asset account, a PDA of this program.
//! No personal key can thaw a holder past the gate or swap the gate out.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        default_account_state::DefaultAccountState, pausable::PausableConfig,
        permanent_delegate::PermanentDelegate, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::{Account as TokenAccountState, AccountState, Mint as MintState},
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount};
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

/// Token ACL, the Solana Foundation's sRFC-37 program, and its per-mint config.
pub const TOKEN_ACL_ID: Pubkey = pubkey!("TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP");
pub const MINT_CONFIG_SEED: &[u8] = b"MINT_CONFIG";
const TOKEN_ACL_CREATE_CONFIG: u8 = 0;
const TOKEN_ACL_FREEZE: u8 = 5;
const TOKEN_ACL_TOGGLE_PERMISSIONLESS: u8 = 8;

pub const MAX_JURISDICTIONS: usize = 32;
/// Accounts the gate needs beyond the five Token ACL always passes.
const GATE_EXTRA_ACCOUNTS: usize = 3;

/// The only mint extensions a serviced asset may carry. Anything else (a
/// transfer hook, a close authority, confidential transfers, fees) either
/// reopens a path around the gate or changes what a unit is.
const ALLOWED_MINT_EXTENSIONS: [ExtensionType; 5] = [
    ExtensionType::DefaultAccountState,
    ExtensionType::PermanentDelegate,
    ExtensionType::Pausable,
    ExtensionType::MetadataPointer,
    ExtensionType::TokenMetadata,
];

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
    /// officer and can hand that role to another key.
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

    pub fn set_compliance(ctx: Context<RegistryAdmin>, compliance: Pubkey) -> Result<()> {
        ctx.accounts.registry.compliance = compliance;
        emit!(ComplianceRotated { registry: ctx.accounts.registry.key(), compliance });
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
        emit!(PolicyUpdated { registry: registry.key(), min_tier, require_accredited });
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

    /// Put a freshly created mint under AssetFlow servicing, in one step: check
    /// the mint is built the way a serviced asset must be, write the gate's
    /// account lists, and hand the mint's freeze authority to Token ACL with
    /// this program as the gate. The mint's own key and the registry admin both
    /// sign, so nobody can register a mint they did not create, or gate one by
    /// a registry whose admin did not agree.
    pub fn register_asset(ctx: Context<RegisterAsset>) -> Result<()> {
        let asset_key = ctx.accounts.asset.key();
        verify_fresh_mint(
            &ctx.accounts.mint.to_account_info(),
            &ctx.accounts.token_program.key(),
            &asset_key,
        )?;

        let asset = &mut ctx.accounts.asset;
        asset.registry = ctx.accounts.registry.key();
        asset.mint = ctx.accounts.mint.key();
        asset.issuer = ctx.accounts.issuer.key();
        asset.bump = ctx.bumps.asset;

        let metas = gate_extra_metas()?;
        ExtraAccountMetaList::init::<ThawQuestion>(
            &mut ctx.accounts.thaw_metas.try_borrow_mut_data()?[..],
            &metas,
        )?;
        ExtraAccountMetaList::init::<FreezeQuestion>(
            &mut ctx.accounts.freeze_metas.try_borrow_mut_data()?[..],
            &metas,
        )?;

        let mint = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[ASSET_SEED, mint.as_ref(), &[ctx.bumps.asset]];
        let mut data = vec![TOKEN_ACL_CREATE_CONFIG];
        data.extend_from_slice(crate::ID.as_ref());
        invoke_signed(
            &Instruction {
                program_id: TOKEN_ACL_ID,
                accounts: vec![
                    AccountMeta::new(ctx.accounts.issuer.key(), true),
                    AccountMeta::new_readonly(asset_key, true),
                    AccountMeta::new(mint, false),
                    AccountMeta::new(ctx.accounts.mint_config.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                ],
                data,
            },
            &[
                ctx.accounts.issuer.to_account_info(),
                ctx.accounts.asset.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.mint_config.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        // Permissionless thaw and freeze both on: holders let themselves in,
        // and anyone may enforce a lapsed approval.
        invoke_signed(
            &Instruction {
                program_id: TOKEN_ACL_ID,
                accounts: vec![
                    AccountMeta::new_readonly(asset_key, true),
                    AccountMeta::new(ctx.accounts.mint_config.key(), false),
                ],
                data: vec![TOKEN_ACL_TOGGLE_PERMISSIONLESS, 1, 1],
            },
            &[ctx.accounts.asset.to_account_info(), ctx.accounts.mint_config.to_account_info()],
            &[seeds],
        )?;

        emit!(AssetRegistered {
            asset: asset_key,
            mint,
            registry: ctx.accounts.registry.key(),
            issuer: ctx.accounts.issuer.key(),
        });
        Ok(())
    }

    /// Issue units to a holder who is eligible today. A thawed account is not
    /// proof of that: an approval can lapse before anyone freezes the account.
    pub fn issue(ctx: Context<Issue>, amount: u64) -> Result<()> {
        require!(amount > 0, AssetFlowError::InvalidAmount);
        let owner = ctx.accounts.destination.owner;
        require!(
            holder_is_eligible(
                &ctx.accounts.asset.key(),
                &ctx.accounts.registry,
                &owner,
                &ctx.accounts.investor.to_account_info(),
            )?,
            AssetFlowError::NotEligible
        );
        require_immutable_owner(&ctx.accounts.destination.to_account_info(), &ctx.accounts.mint.key())?;

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
        )?;
        emit!(Issued {
            asset: ctx.accounts.asset.key(),
            destination: ctx.accounts.destination.key(),
            owner,
            amount,
        });
        Ok(())
    }

    /// Compliance freezes a holder account directly, whatever the gate would
    /// say: a sanctions hit or a court order does not wait for a profile
    /// update. Goes through Token ACL's own freeze, which never calls the gate.
    pub fn force_freeze(ctx: Context<ForceFreeze>, reason: u16) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[ASSET_SEED, mint.as_ref(), &[ctx.accounts.asset.bump]];
        invoke_signed(
            &Instruction {
                program_id: TOKEN_ACL_ID,
                accounts: vec![
                    AccountMeta::new_readonly(ctx.accounts.asset.key(), true),
                    AccountMeta::new_readonly(mint, false),
                    AccountMeta::new(ctx.accounts.token_account.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.mint_config.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                ],
                data: vec![TOKEN_ACL_FREEZE],
            },
            &[
                ctx.accounts.asset.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.token_account.to_account_info(),
                ctx.accounts.mint_config.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        emit!(ComplianceFreeze {
            asset: ctx.accounts.asset.key(),
            token_account: ctx.accounts.token_account.key(),
            reason,
        });
        Ok(())
    }

    /// Token ACL asks this before a permissionless thaw: yes only if the
    /// account's owner is eligible today and can never be changed.
    #[instruction(discriminator = ThawQuestion::SPL_DISCRIMINATOR_SLICE)]
    pub fn can_thaw_permissionless(ctx: Context<GateCheck>) -> Result<()> {
        // A thawed account whose owner could still be reassigned would carry
        // one holder's approval to any wallet it is handed to.
        require_immutable_owner(&ctx.accounts.token_account.to_account_info(), &ctx.accounts.mint.key())?;
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

/// A serviced asset's mint must be a Token-2022 mint with nothing issued yet,
/// every authority held by the asset account, holder accounts frozen by
/// default, and no extension outside the allow-list.
fn verify_fresh_mint(mint: &AccountInfo, token_2022: &Pubkey, asset: &Pubkey) -> Result<()> {
    require_keys_eq!(*mint.owner, *token_2022, AssetFlowError::MintNotToken2022);
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(AssetFlowError::MintNotToken2022))?;
    let is_asset = |key: Option<[u8; 32]>| key == Some(asset.to_bytes());

    require!(state.base.supply == 0, AssetFlowError::MintNotFresh);
    let mint_authority: Option<Pubkey> = state.base.mint_authority.into();
    require!(is_asset(mint_authority.map(|k| k.to_bytes())), AssetFlowError::MintAuthorityNotAsset);
    let freeze_authority: Option<Pubkey> = state.base.freeze_authority.into();
    require!(is_asset(freeze_authority.map(|k| k.to_bytes())), AssetFlowError::FreezeAuthorityNotAsset);

    let extensions = state
        .get_extension_types()
        .map_err(|_| error!(AssetFlowError::ForbiddenExtension))?;
    require!(
        extensions.iter().all(|e| ALLOWED_MINT_EXTENSIONS.contains(e)),
        AssetFlowError::ForbiddenExtension
    );

    let default_state = state
        .get_extension::<DefaultAccountState>()
        .map_err(|_| error!(AssetFlowError::DefaultStateNotFrozen))?;
    require!(
        default_state.state == AccountState::Frozen as u8,
        AssetFlowError::DefaultStateNotFrozen
    );
    let delegate = state
        .get_extension::<PermanentDelegate>()
        .map_err(|_| error!(AssetFlowError::DelegateNotAsset))?;
    let delegate: Option<Pubkey> = delegate.delegate.into();
    require!(is_asset(delegate.map(|k| k.to_bytes())), AssetFlowError::DelegateNotAsset);
    let pause = state
        .get_extension::<PausableConfig>()
        .map_err(|_| error!(AssetFlowError::PauseAuthorityNotAsset))?;
    let pause_authority: Option<Pubkey> = pause.authority.into();
    require!(is_asset(pause_authority.map(|k| k.to_bytes())), AssetFlowError::PauseAuthorityNotAsset);
    require!(!bool::from(pause.paused), AssetFlowError::MintPaused);
    Ok(())
}

/// A holder account the gate or issuance may rely on: a Token-2022 account of
/// this mint whose owner can never be reassigned. Associated token accounts
/// always carry ImmutableOwner; a hand-made account must opt in.
fn require_immutable_owner(token_account: &AccountInfo, mint: &Pubkey) -> Result<()> {
    require!(
        token_account.owner.to_bytes() == anchor_spl::token_2022::ID.to_bytes(),
        AssetFlowError::OwnerNotImmutable
    );
    let data = token_account.try_borrow_data()?;
    let state = StateWithExtensions::<TokenAccountState>::unpack(&data)
        .map_err(|_| error!(AssetFlowError::OwnerNotImmutable))?;
    require!(state.base.mint.to_bytes() == mint.to_bytes(), AssetFlowError::WrongMint);
    let extensions = state
        .get_extension_types()
        .map_err(|_| error!(AssetFlowError::OwnerNotImmutable))?;
    require!(
        extensions.contains(&ExtensionType::ImmutableOwner),
        AssetFlowError::OwnerNotImmutable
    );
    Ok(())
}

/// Whether `owner` may hold the asset today. Accounts the asset itself owns
/// (payout and redemption vaults) are servicing counterparties, never
/// investors; payout snapshots must leave them out.
fn holder_is_eligible(
    asset: &Pubkey,
    registry: &Registry,
    owner: &Pubkey,
    investor: &AccountInfo,
) -> Result<bool> {
    if owner == asset {
        return Ok(true);
    }
    if investor.owner != &crate::ID || investor.data_is_empty() {
        return Ok(false);
    }
    let profile = InvestorProfile::try_deserialize(&mut &investor.try_borrow_data()?[..])?;
    Ok(registry.admits(&profile, Clock::get()?.unix_timestamp))
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
pub struct RegistryAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
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
    pub issuer: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(has_one = admin @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
    /// The mint's own key signs: only whoever created it can register it.
    #[account(mut)]
    pub mint: Signer<'info>,
    #[account(
        init,
        payer = issuer,
        space = 8 + Asset::INIT_SPACE,
        seeds = [ASSET_SEED, mint.key().as_ref()],
        bump
    )]
    pub asset: Account<'info, Asset>,
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
    /// CHECK: Token ACL creates it in this instruction.
    #[account(
        mut,
        seeds = [MINT_CONFIG_SEED, mint.key().as_ref()],
        bump,
        seeds::program = token_acl_program.key()
    )]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Issue<'info> {
    pub issuer: Signer<'info>,
    #[account(
        has_one = issuer @ AssetFlowError::Unauthorized,
        has_one = mint,
        has_one = registry
    )]
    pub asset: Account<'info, Asset>,
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: may not exist. A wallet with no profile is not eligible.
    #[account(seeds = [INVESTOR_SEED, registry.key().as_ref(), destination.owner.as_ref()], bump)]
    pub investor: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct ForceFreeze<'info> {
    pub compliance: Signer<'info>,
    #[account(has_one = compliance @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
    #[account(has_one = registry, has_one = mint)]
    pub asset: Account<'info, Asset>,
    /// CHECK: bound to the asset by has_one.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Token-2022 refuses an account that is not of this mint.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: Token ACL's config for this mint.
    #[account(
        seeds = [MINT_CONFIG_SEED, mint.key().as_ref()],
        bump,
        seeds::program = token_acl_program.key()
    )]
    pub mint_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the Token ACL program id.
    #[account(address = TOKEN_ACL_ID)]
    pub token_acl_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
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
        holder_is_eligible(
            &self.asset.key(),
            &self.registry,
            &self.owner.key(),
            &self.investor.to_account_info(),
        )
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
pub struct PolicyUpdated {
    pub registry: Pubkey,
    pub min_tier: u8,
    pub require_accredited: bool,
}

#[event]
pub struct ComplianceRotated {
    pub registry: Pubkey,
    pub compliance: Pubkey,
}

#[event]
pub struct InvestorProfileUpdated {
    pub registry: Pubkey,
    pub wallet: Pubkey,
    pub terms: ProfileTerms,
}

#[event]
pub struct AssetRegistered {
    pub asset: Pubkey,
    pub mint: Pubkey,
    pub registry: Pubkey,
    pub issuer: Pubkey,
}

#[event]
pub struct Issued {
    pub asset: Pubkey,
    pub destination: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ComplianceFreeze {
    pub asset: Pubkey,
    pub token_account: Pubkey,
    pub reason: u16,
}

/// Codes are 6000 + position; the client maps them by number, so new errors
/// go at the end.
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
    #[msg("the mint's freeze authority must be the asset account")]
    FreezeAuthorityNotAsset,
    #[msg("the mint must have no supply when it is registered")]
    MintNotFresh,
    #[msg("the mint must be a Token-2022 mint")]
    MintNotToken2022,
    #[msg("the mint carries an extension a serviced asset may not have")]
    ForbiddenExtension,
    #[msg("holder accounts must start frozen")]
    DefaultStateNotFrozen,
    #[msg("the permanent delegate must be the asset account")]
    DelegateNotAsset,
    #[msg("the pause authority must be the asset account")]
    PauseAuthorityNotAsset,
    #[msg("the mint is paused")]
    MintPaused,
    #[msg("holder accounts must have an owner that can never change")]
    OwnerNotImmutable,
    #[msg("token account belongs to a different mint")]
    WrongMint,
}
