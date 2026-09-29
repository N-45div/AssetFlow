# AssetFlow

**The servicing layer for tokenized assets: who may hold them, what each holder is owed on the record date, and how they redeem, enforced on-chain and run from one console.**

Issuance is day one. A tokenized bond or fund still has to be run every day after: holder eligibility, transfer restrictions, coupons and dividends, redemptions, maturity. Today that work lives in spreadsheets and email next to a token on-chain. AssetFlow puts it where the token is.

Live app (Solana devnet): **https://assetflow-servicing.vercel.app** (also at assetflow-hashkey.vercel.app)

## Where it runs

| Chain | Status | What is there |
|---|---|---|
| **Solana** | Devnet | The servicing layer, built natively on Token-2022 and Token ACL (sRFC-37). Program `BWDCF6dLYETPYquDGKm8X6pyLnMZGhisporuTbozjtwR`. |
| **HashKey Chain** | Mainnet (chain 177), deployed 11 May 2026 | The EVM contracts AssetFlow started as: [ComplianceRegistry](https://hsk.blockscout.com/address/0xd06ea0b9AD8935df0e823555F0433604B880711D), [ServicedAssetToken "AssetFlow Pilot Unit"](https://hsk.blockscout.com/address/0x59E0f69FF6d25b5ceE757c874adAdC42E9857f2A), [DistributionModule](https://hsk.blockscout.com/address/0x93995825CA13fBbf74f6876480bf7565f33a8717), [RedemptionModule](https://hsk.blockscout.com/address/0x7495d785B5edA74E2c3ebc4B4c0909DeF86078bB). Recorded in [`contracts/deployments/hashkey-mainnet.json`](contracts/deployments/hashkey-mainnet.json). |
| **Base** | Mainnet and Sepolia, deployed 29 Sep 2026 | The same servicing as Solidity contracts ([`evm/`](evm)). Mainnet: the [directory](https://base.blockscout.com/address/0x1C1867cC4899157B8c6fb2D1d351985f73fe125e), AssetFlow's investor schema on Base's EAS, and a pilot note on native USDC ([servicer](https://base.blockscout.com/address/0xCc673fD915EE01f2F712A880a51E42EDC9A7d320), [token](https://base.blockscout.com/address/0xDABea95f39ef319AE4C775Ca8c8b3c37971Aa977)), sources verified on Sourcify. The console at [`/base`](https://assetflow-servicing.vercel.app/base) runs on Sepolia with test dollars. Recorded in [`evm/deployments`](evm/deployments). |
| Arbitrum, Robinhood Chain | Planned | Tokenized stocks there reinvest dividends through a multiplier and never pay cash; AssetFlow is the cash-payout rail. |

## How it works on Solana

**Eligibility without a transfer hook.** The asset is a Token-2022 mint whose holder accounts start frozen (Default Account State). Token ACL, the Solana Foundation's sRFC-37 program, holds the freeze authority and asks the AssetFlow program, as the mint's *gate*, before any thaw or freeze:

- a holder can thaw their own account only if their investor profile passes the registry: approved, KYC in date, allowed jurisdiction, sufficient tier, accreditation where required;
- anyone can freeze a holder who no longer passes, so a lapsed approval is enforceable without the issuer;
- nobody can freeze a holder in good standing.

A plain Token-2022 transfer runs none of AssetFlow's code, so every wallet and program that handles Token-2022 handles the asset.

**No personal key can reach around the gate.** Every authority over the mint, including mint, freeze via Token ACL, pause and permanent delegate, belongs to the asset account, a PDA of the program. Registration is one step that checks how the mint is built (holder accounts frozen by default, no transfer hook, close authority, confidential transfers or fees) and hands the freeze authority to Token ACL itself. The gate thaws only accounts whose owner can never change, and issuance re-checks eligibility.

The public [proof page](https://assetflow-servicing.vercel.app/proof) reads each of these guarantees back from the chain and links to the account that proves it.

**KYC once.** A registry can trust a KYC provider on the [Solana Attestation Service](https://github.com/solana-foundation/solana-attestation-service): its attestation about an investor's wallet (jurisdiction, tier, accredited) becomes that investor's profile, written by the program, not typed in by the issuer. Anyone can present the attestation, so an investor verified once onboards into every registry that trusts the provider. The registry's own policy still applies, and a compliance hold is never lifted by an attestation. When the provider revokes it, it expires, or the registry stops trusting the provider, anyone can withdraw the approval, and the gate then lets anyone freeze the holder. The site runs a demo provider at `/kyc` that attests whatever a visitor picks, and says so.

**Coupons.** The instrument's terms live on-chain, and every amount is computed by the program: 30/360, rounded down to the cent on each holder's total holding. On the record date anyone can fix the register (the mint pauses so no unit moves), the issuer commits a Merkle root of units per holder that must add up to the supply, and once the payment's own vault is fully funded anyone can pay each holder. A holder who is no longer eligible has their coupon held back.

**Redemptions and maturity.** A holder asks to redeem early and the units wait in an escrow the asset account owns. The issuer settles at face plus accrued interest, priced by the program, and the units burn in the same transaction as the USDC moves; or rejects, and the units go back, into a frozen account too. Units in escrow on a record date still count to their holder. Once the last payment date has passed and every coupon's register is committed, anyone can start maturity: the mint authority is dropped for good, and once the principal is fully funded anyone can redeem any holding at face. An ineligible holder keeps their units, and their principal waits in the vault.

## How it works on Base

The Solana program's rules and arithmetic, in Solidity: a `Registry` (the same policy and profiles, and KYC once through the Ethereum Attestation Service, a Base predeploy), and per bond a `Servicer` that holds the terms and creates its `ServicedToken`.

- **The register keeps itself.** The token records every holder's balance over time, so a coupon is owed on the balance at the record date, read from the chain: nobody commits a Merkle root and nothing is paused. Anyone pays any holder once the payment is fully funded, each payment only from its own funds, and an ineligible holder's coupon is held back.
- **The gate runs on every transfer.** Units move only between wallets the registry admits today, so a lapsed approval stops the next transfer outright.
- **Redemptions lock in place.** Requested units stay in the holder's wallet, locked, until the issuer settles (face plus accrued interest, burned in the same call) or rejects. Maturity after the last payment date stops issuance, and anyone redeems eligible holdings at face once the principal is funded.
- **KYC once.** A registry trusts an attester's EAS attestations (`uint16 jurisdiction, uint8 tier, bool accredited`); anyone may present one to write the investor's profile, a compliance hold survives it, and a revocation lets anyone withdraw the approval. The site's demo provider signs delegated attestations the investor's wallet submits.

## The app

- **Issuer console** (`/issuer`): self-serve set-up (an investor registry, then the asset created and registered in one transaction), an investor register joined with every holder account on-chain, issuance, coupons from terms to paid, the redemption queue and maturity, and compliance policy.
- **Holder portal** (`/holder`): an eligibility checklist that names the rule a wallet fails, onboarding with a KYC attestation, and one-transaction account activation. An ineligible wallet can "try anyway" and get the gate's refusal as its own on-chain transaction. Holders see each coupon, ask to redeem early with the price shown before they sign, and redeem at maturity.
- **Demo KYC provider** (`/kyc`): attests a wallet on the Solana Attestation Service, and revokes it, to show KYC once end to end.
- **Proof** (`/proof`): nine guarantees checked live against the chain.
- English, Simplified Chinese and Traditional Chinese (Hong Kong).

## Repository

- [`solana/`](solana): the Anchor program, a hand-built client and local-validator tests (54 cases across eligibility, KYC once against the real Solana Attestation Service, coupons, and redemptions and maturity, including the attacks an adversarial review found).
- [`evm/`](evm): the Solidity contracts for Base (Foundry), with 19 tests against the real EAS contracts, including a fuzzed rounding check.
- [`frontend/`](frontend): the Next.js app.
- [`contracts/`](contracts): the Solidity contracts deployed on HashKey Chain.
- [`backend/`](backend): the Express API the HashKey console used.

## Run it locally

Solana program and tests (in WSL; see `solana/build.sh`):

```bash
wsl bash solana/build.sh
wsl bash solana/tests/validator.sh      # terminal 1: validator with AssetFlow + Token ACL
cd solana && npm install && npm test    # terminal 2
```

EVM contracts and tests (Foundry):

```bash
cd evm && npm install && npm run setup && forge test
```

App against the local validator:

```bash
cd frontend && npm install && npm run dev
```

The app defaults to a local validator and offers a dev wallet there. For devnet, set `NEXT_PUBLIC_SOLANA_CLUSTER=devnet`, `NEXT_PUBLIC_RPC_PROXY=1` and a server-side `SOLANA_RPC_URL`.

## Development history

AssetFlow began as an EVM project for the HashKey Chain Horizon hackathon (April 2026): the Solidity contracts, the Express backend and the first console, deployed to HashKey testnet in April and HashKey mainnet in May. The Solana program, its tests and the current app were written from 28 September 2026 for Colosseum's Crypto World's Fair; see the git history.

## License

MIT
