//! KYC once: investor profiles from Solana Attestation Service attestations.
//!
//! A registry can name the SAS credential and schema it trusts: a KYC
//! provider's attestations about investors. An investor verified by that
//! provider then needs nothing from the issuer. Anyone may present their
//! attestation, and the program writes the investor profile from it; the gate
//! reads that profile as it reads any other. Every registry that trusts the
//! same provider accepts the same attestation, so an investor is verified once.
//!
//! The attestation stays the source. When the provider revokes it, it
//! expires, or the registry stops trusting its provider, anyone may lapse the
//! profile, and from then on anyone may freeze the holder through the gate. A
//! compliance hold is the registry's own word and a claim never lifts it.

use anchor_lang::prelude::*;

use crate::{AssetFlowError, InvestorProfile, Registry, INVESTOR_SEED};

/// The Solana Foundation's Solana Attestation Service.
pub const SAS_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
pub const KYC_SOURCE_SEED: &[u8] = b"kyc_source";
pub const ATTESTED_SEED: &[u8] = b"attested";
/// A profile from an attestation that never expires: 9999-12-31 23:59:59 UTC,
/// a date every client can still show.
pub const NO_EXPIRY: i64 = 253_402_300_799;

/// SAS account discriminators (one byte, not Anchor's eight).
const SAS_CREDENTIAL: u8 = 0;
const SAS_SCHEMA: u8 = 1;
const SAS_ATTESTATION: u8 = 2;

/// The fields an investor attestation must carry, as SAS type codes:
/// jurisdiction (u16, ISO 3166-1 numeric), tier (u8), accredited (bool).
pub const INVESTOR_LAYOUT: [u8; 3] = [1, 0, 10];

/// The attestation source a registry trusts. Default keys mean none.
#[account]
#[derive(InitSpace)]
pub struct KycSource {
    pub registry: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub bump: u8,
}

/// Marks a profile as written from an attestation, and which one.
#[account]
#[derive(InitSpace)]
pub struct AttestedProfile {
    pub registry: Pubkey,
    pub wallet: Pubkey,
    pub attestation: Pubkey,
    pub claimed_ts: i64,
    pub bump: u8,
}

/// Reads SAS's length-prefixed layout.
struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or(error!(AssetFlowError::NotAnAttestation))?;
        let out = self.data.get(self.at..end).ok_or(error!(AssetFlowError::NotAnAttestation))?;
        self.at = end;
        Ok(out)
    }
    fn key(&mut self) -> Result<Pubkey> {
        Ok(Pubkey::new_from_array(self.take(32)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> Result<&'a [u8]> {
        let len = u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize;
        self.take(len)
    }
}

/// An account SAS owns, with the discriminator expected, as a cursor past it.
fn sas_account<'a>(info: &AccountInfo, data: &'a [u8], discriminator: u8) -> Result<Cursor<'a>> {
    require_keys_eq!(*info.owner, SAS_ID, AssetFlowError::NotAnAttestation);
    require!(data.first() == Some(&discriminator), AssetFlowError::NotAnAttestation);
    Ok(Cursor { data, at: 1 })
}

pub struct InvestorAttestation {
    pub nonce: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub jurisdiction: u16,
    pub tier: u8,
    pub accredited: bool,
    pub expiry: i64,
}

pub fn read_attestation(info: &AccountInfo) -> Result<InvestorAttestation> {
    let data = info.try_borrow_data()?;
    let mut c = sas_account(info, &data, SAS_ATTESTATION)?;
    let nonce = c.key()?;
    let credential = c.key()?;
    let schema = c.key()?;
    let fields = c.bytes()?;
    c.key()?; // signer
    let expiry = i64::from_le_bytes(c.take(8)?.try_into().unwrap());
    // the trusted schema fixes the layout, so the fields are exactly these
    require!(fields.len() == 4 && fields[3] <= 1, AssetFlowError::WrongSchemaLayout);
    Ok(InvestorAttestation {
        nonce,
        credential,
        schema,
        jurisdiction: u16::from_le_bytes([fields[0], fields[1]]),
        tier: fields[2],
        accredited: fields[3] == 1,
        expiry,
    })
}

/// Whether an attestation still vouches for `wallet` under the registry's source.
fn vouches(a: &InvestorAttestation, source: &KycSource, wallet: &Pubkey, now: i64) -> bool {
    a.credential == source.credential
        && a.schema == source.schema
        && a.nonce == *wallet
        && (a.expiry == 0 || a.expiry > now)
}

pub fn set_source(ctx: Context<SetKycSource>, accept: bool) -> Result<()> {
    let registry = ctx.accounts.registry.key();
    let (credential, schema) = if accept {
        let credential = ctx.accounts.credential.to_account_info();
        sas_account(&credential, &credential.try_borrow_data()?, SAS_CREDENTIAL)?;
        let info = ctx.accounts.schema.to_account_info();
        let data = info.try_borrow_data()?;
        let mut c = sas_account(&info, &data, SAS_SCHEMA)?;
        require_keys_eq!(c.key()?, credential.key(), AssetFlowError::AttestationMismatch);
        c.bytes()?; // name
        c.bytes()?; // description
        let layout = c.bytes()?;
        c.bytes()?; // field names
        let paused = c.take(1)?[0] == 1;
        require!(layout == INVESTOR_LAYOUT && !paused, AssetFlowError::WrongSchemaLayout);
        (credential.key(), info.key())
    } else {
        (Pubkey::default(), Pubkey::default())
    };
    let source = &mut ctx.accounts.source;
    source.registry = registry;
    source.credential = credential;
    source.schema = schema;
    source.bump = ctx.bumps.source;
    emit!(KycSourceSet { registry, credential, schema });
    Ok(())
}

pub fn claim(ctx: Context<ClaimProfile>) -> Result<()> {
    let source = &ctx.accounts.source;
    require!(source.credential != Pubkey::default(), AssetFlowError::KycSourceNotSet);
    let wallet = ctx.accounts.wallet.key();
    let a = read_attestation(&ctx.accounts.attestation.to_account_info())?;
    require!(
        a.credential == source.credential && a.schema == source.schema && a.nonce == wallet,
        AssetFlowError::AttestationMismatch
    );
    let now = Clock::get()?.unix_timestamp;
    require!(a.expiry == 0 || a.expiry > now, AssetFlowError::AttestationExpired);

    let registry = ctx.accounts.registry.key();
    let profile = &mut ctx.accounts.investor;
    profile.registry = registry;
    profile.wallet = wallet;
    profile.approved = true;
    profile.accredited = a.accredited;
    profile.tier = a.tier;
    profile.jurisdiction = a.jurisdiction;
    profile.expiry = if a.expiry == 0 { NO_EXPIRY } else { a.expiry };
    profile.bump = ctx.bumps.investor;
    // `frozen` is left as it is: a compliance hold outlives any attestation.

    let marker = &mut ctx.accounts.marker;
    marker.registry = registry;
    marker.wallet = wallet;
    marker.attestation = ctx.accounts.attestation.key();
    marker.claimed_ts = now;
    marker.bump = ctx.bumps.marker;
    emit!(ProfileClaimed {
        registry,
        wallet,
        attestation: marker.attestation,
        jurisdiction: a.jurisdiction,
        tier: a.tier,
        accredited: a.accredited,
    });
    Ok(())
}

pub fn lapse(ctx: Context<LapseProfile>) -> Result<()> {
    let wallet = ctx.accounts.marker.wallet;
    let info = ctx.accounts.attestation.to_account_info();
    // A closed account, or anything SAS no longer holds there, vouches for nobody.
    let still = !info.data_is_empty()
        && read_attestation(&info)
            .map(|a| vouches(&a, &ctx.accounts.source, &wallet, Clock::get().map(|c| c.unix_timestamp).unwrap_or(0)))
            .unwrap_or(false);
    require!(!still, AssetFlowError::StillAttested);
    ctx.accounts.investor.approved = false;
    emit!(ProfileLapsed { registry: ctx.accounts.registry.key(), wallet, attestation: info.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct SetKycSource<'info> {
    #[account(mut)]
    pub compliance: Signer<'info>,
    #[account(has_one = compliance @ AssetFlowError::Unauthorized)]
    pub registry: Account<'info, Registry>,
    #[account(
        init_if_needed,
        payer = compliance,
        space = 8 + KycSource::INIT_SPACE,
        seeds = [KYC_SOURCE_SEED, registry.key().as_ref()],
        bump
    )]
    pub source: Account<'info, KycSource>,
    /// CHECK: the provider's SAS credential; read and checked when accepted.
    pub credential: UncheckedAccount<'info>,
    /// CHECK: its investor schema; read and checked when accepted.
    pub schema: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimProfile<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub registry: Account<'info, Registry>,
    #[account(seeds = [KYC_SOURCE_SEED, registry.key().as_ref()], bump = source.bump, has_one = registry)]
    pub source: Account<'info, KycSource>,
    /// CHECK: read as a SAS attestation and checked in the handler.
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: the investor; must be the wallet the attestation names.
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + InvestorProfile::INIT_SPACE,
        seeds = [INVESTOR_SEED, registry.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub investor: Account<'info, InvestorProfile>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AttestedProfile::INIT_SPACE,
        seeds = [ATTESTED_SEED, registry.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub marker: Account<'info, AttestedProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LapseProfile<'info> {
    pub registry: Account<'info, Registry>,
    #[account(seeds = [KYC_SOURCE_SEED, registry.key().as_ref()], bump = source.bump, has_one = registry)]
    pub source: Account<'info, KycSource>,
    #[account(
        seeds = [ATTESTED_SEED, registry.key().as_ref(), marker.wallet.as_ref()],
        bump = marker.bump,
        has_one = registry
    )]
    pub marker: Account<'info, AttestedProfile>,
    #[account(
        mut,
        seeds = [INVESTOR_SEED, registry.key().as_ref(), marker.wallet.as_ref()],
        bump = investor.bump
    )]
    pub investor: Account<'info, InvestorProfile>,
    /// CHECK: whatever is now at the address the profile was claimed from.
    #[account(address = marker.attestation)]
    pub attestation: UncheckedAccount<'info>,
}

#[event]
pub struct KycSourceSet {
    pub registry: Pubkey,
    pub credential: Pubkey,
    pub schema: Pubkey,
}

#[event]
pub struct ProfileClaimed {
    pub registry: Pubkey,
    pub wallet: Pubkey,
    pub attestation: Pubkey,
    pub jurisdiction: u16,
    pub tier: u8,
    pub accredited: bool,
}

#[event]
pub struct ProfileLapsed {
    pub registry: Pubkey,
    pub wallet: Pubkey,
    pub attestation: Pubkey,
}
