# AssetFlow

**The servicing layer for tokenized assets: who may hold them, what each holder is owed on the record date, and how they redeem, enforced on-chain and run from one console.**

Issuance is day one. A tokenized bond or fund still has to be run every day after: holder eligibility, transfer restrictions, coupons and dividends, redemptions, maturity. Today that work lives in spreadsheets and email next to a token on-chain. AssetFlow puts it where the token is.

Live app (Solana devnet): **https://assetflow-servicing.vercel.app** (also at assetflow-hashkey.vercel.app)

## Where it runs

| Chain | Status | What is there |
|---|---|---|
| **Solana** | Devnet | The servicing layer, built natively on Token-2022 and Token ACL (sRFC-37), with optional private holdings in MagicBlock's Private Ephemeral Rollup. Program `BWDCF6dLYETPYquDGKm8X6pyLnMZGhisporuTbozjtwR`. |
| **HashKey Chain** | Mainnet (chain 177), deployed 11 May 2026 | The EVM contracts AssetFlow started as: [ComplianceRegistry](https://hsk.blockscout.com/address/0xd06ea0b9AD8935df0e823555F0433604B880711D), [ServicedAssetToken "AssetFlow Pilot Unit"](https://hsk.blockscout.com/address/0x59E0f69FF6d25b5ceE757c874adAdC42E9857f2A), [DistributionModule](https://hsk.blockscout.com/address/0x93995825CA13fBbf74f6876480bf7565f33a8717), [RedemptionModule](https://hsk.blockscout.com/address/0x7495d785B5edA74E2c3ebc4B4c0909DeF86078bB). Recorded in [`contracts/deployments/hashkey-mainnet.json`](contracts/deployments/hashkey-mainnet.json). |
| **Base** | Mainnet and Sepolia, deployed 29 Sep 2026 | The same servicing as Solidity contracts ([`evm/`](evm)). Mainnet: the [directory](https://base.blockscout.com/address/0x1C1867cC4899157B8c6fb2D1d351985f73fe125e), AssetFlow's investor schema on Base's EAS, and a pilot note on native USDC ([servicer](https://base.blockscout.com/address/0xCc673fD915EE01f2F712A880a51E42EDC9A7d320), [token](https://base.blockscout.com/address/0xDABea95f39ef319AE4C775Ca8c8b3c37971Aa977)), sources verified on Sourcify. The console at [`/base`](https://assetflow-servicing.vercel.app/base) runs on Sepolia with test dollars. Recorded in [`evm/deployments`](evm/deployments). |
| **Arbitrum** | One and Sepolia, deployed 29 Sep 2026 | The same contracts at the same addresses as on Base mainnet: the [directory](https://arbitrum.blockscout.com/address/0x1C1867cC4899157B8c6fb2D1d351985f73fe125e), the investor schema on Arbitrum's EAS, and the pilot note on native USDC ([servicer](https://arbitrum.blockscout.com/address/0xCc673fD915EE01f2F712A880a51E42EDC9A7d320), [token](https://arbitrum.blockscout.com/address/0xDABea95f39ef319AE4C775Ca8c8b3c37971Aa977)), verified on Sourcify. The console at [`/arbitrum`](https://assetflow-servicing.vercel.app/arbitrum) runs on Arbitrum Sepolia, against Arbitrum's EAS there. Recorded in [`evm/deployments/arbitrum.json`](evm/deployments/arbitrum.json) and [`arbitrum-sepolia.json`](evm/deployments/arbitrum-sepolia.json). |
| **Robinhood Chain** | Testnet (chain 46630), deployed 29 Sep 2026 | Tokenized stocks there reinvest dividends through a multiplier and never pay cash; AssetFlow is the cash-payout rail. The same contracts at the same addresses, and, since the chain has no Ethereum Attestation Service yet, the EAS Foundation's own [SchemaRegistry](https://explorer.testnet.chain.robinhood.com/address/0xbbE819AB63f68b6C39576F0356EB9087fFF5444f) and [EAS](https://explorer.testnet.chain.robinhood.com/address/0xdD5Fc46c9f5C87e887614DB3b124e51A4A5540A1) contracts, deployed unmodified; all verified on Sourcify. The console runs at [`/robinhood`](https://assetflow-servicing.vercel.app/robinhood). Recorded in [`evm/deployments/robinhood-testnet.json`](evm/deployments/robinhood-testnet.json). |

## How it works on Solana

**Eligibility without a transfer hook.** The asset is a Token-2022 mint whose holder accounts start frozen (Default Account State). Token ACL, the Solana Foundation's sRFC-37 program, holds the freeze authority and asks the AssetFlow program, as the mint's *gate*, before any thaw or freeze:

- a holder can thaw their own account only if their investor profile passes the registry: approved, KYC in date, allowed jurisdiction, sufficient tier, accreditation where required;
- anyone can freeze a holder who no longer passes, so a lapsed approval is enforceable without the issuer;
- nobody can freeze a holder in good standing.

A plain Token-2022 transfer runs none of AssetFlow's code, so every wallet and program that handles Token-2022 handles the asset.

**No personal key can reach around the gate.** Every authority over the mint, including mint, freeze via Token ACL, pause and permanent delegate, belongs to the asset account, a PDA of the program. Registration is one step that checks how the mint is built (holder accounts frozen by default, no transfer hook, close authority, confidential transfers or fees) and hands the freeze authority to Token ACL itself. The gate thaws only accounts whose owner can never change, and issuance re-checks eligibility.

The public [proof page](https://assetflow-servicing.vercel.app/proof) reads each of these guarantees back from the chain and links to the account that proves it.

**KYC once.** A registry can trust a KYC provider on the [Solana Attestation Service](https://github.com/solana-foundation/solana-attestation-service): its attestation about an investor's wallet (jurisdiction, tier, accredited) becomes that investor's profile, written by the program, not typed in by the issuer. Anyone can present the attestation, so an investor verified once onboards into every registry that trusts the provider. The registry's own policy still applies, and a compliance hold is never lifted by an attestation. When the provider revokes it, it expires, or the registry stops trusting the provider, anyone can withdraw the approval, and the gate then lets anyone freeze the holder. The site runs a demo provider at `/kyc` that attests whatever a visitor picks, and says so.

**Coupons.** The instrument's terms live on-chain, and every amount is computed by the program: 30/360, rounded down to the cent on each holder's total holding. On the record date anyone can fix the register: the mint pauses so no unit moves, and the payment is priced from the supply. Anyone then counts the register into the program, one source at a time: each holder account, each open redemption request, and the private escrow as one line. Each source counts once, in any order, so nobody can stall the count by skipping one, and a holder's accounts add up to one entitlement. Once the count reaches the supply, anyone closes it and the mint resumes. Nobody tells the program who holds what, and no key of the issuer's is needed to end the pause. Once the payment's own vault is fully funded, anyone can pay each holder, the holder included. A holder who is no longer eligible has their coupon held back.

**Redemptions and maturity.** A holder asks to redeem early and the units wait in an escrow the asset account owns. The issuer settles at face plus accrued interest, priced by the program, and the units burn in the same transaction as the USDC moves; or rejects, and the units go back, into a frozen account too. Units in escrow on a record date still count to their holder. Once the last payment date has passed and every coupon's register is counted, anyone can start maturity: the mint authority is dropped for good, and once the principal is fully funded anyone can redeem any holding at face. An ineligible holder keeps their units, and their principal waits in the vault.

**Private holdings, in MagicBlock's Private Ephemeral Rollup.** An issuer can let holders park units out of public view. A holder deposits units on Solana into an escrow the asset account owns. Their share is kept in an AssetFlow account delegated to MagicBlock's private rollup, a validator running in an Intel TDX trusted execution environment. The program accepts no other validator. Inside the rollup, AssetFlow's own instructions move units between holders, and both sides must be eligible today, as on Solana. A compliance hold stops a holding from sending anything. Units come back out through an exit ticket the rollup commits to Solana, and a release from the escrow that anyone can send.

- **Who sees what.** Balances, private transfers and each holder's coupon can be read only by the holder, the issuer, compliance and an auditor the issuer names. Public on Solana: who has a private account, every deposit and every release (they are token movements), and the escrow's total. A holding's balance is never committed to Solana; only exit amounts are, and they are public once they land.
- **No balance leaks through failures.** No rollup instruction fails because of a private value. A move takes at most what is there, and a held holding simply does not move, so a stranger simulating someone else's transactions learns nothing.
- **Coupons stay private and still add up.** The public register counts the escrow as one line. Each private holder's share is fixed from what their Solana ledger recorded at the fix, so the shares always add up to the escrow, however late the rollup sees the fix. Each holder's coupon is credited inside the rollup and taken out like units. Coupon cash goes only to a wallet that is eligible at that time.
- **A way out that does not need the rollup to run AssetFlow.** A holder can ask MagicBlock's delegation program on Solana to bring their holding back, then take everything out. This publishes their balance.
- **What you trust.** MagicBlock's TEE validator and its operator. The issuer, compliance and the auditor can read every private balance. If the validator's state were lost for good, balances it never committed could not be recovered on-chain: the escrow would keep the units with no on-chain record of whose they are.

## How it works on Base

The Solana program's rules and arithmetic, in Solidity: a `Registry` (the same policy and profiles, and KYC once through the Ethereum Attestation Service, a Base predeploy), and per bond a `Servicer` that holds the terms and creates its `ServicedToken`.

- **The register keeps itself.** The token records every holder's balance over time, so a coupon is owed on the balance at the record date, read from the chain: nobody commits a Merkle root and nothing is paused. Anyone pays any holder once the payment is fully funded, each payment only from its own funds, and an ineligible holder's coupon is held back.
- **The gate runs on every transfer.** Units move only between wallets the registry admits today, so a lapsed approval stops the next transfer outright.
- **Redemptions lock in place.** Requested units stay in the holder's wallet, locked, until the issuer settles (face plus accrued interest, burned in the same call) or rejects. Maturity after the last payment date stops issuance, and anyone redeems eligible holdings at face once the principal is funded.
- **KYC once.** A registry trusts an attester's EAS attestations (`uint16 jurisdiction, uint8 tier, bool accredited`); anyone may present one to write the investor's profile, a compliance hold survives it, and a revocation lets anyone withdraw the approval. The site's demo provider signs delegated attestations the investor's wallet submits.

## The app

- **Issuer console** (`/issuer`): self-serve set-up (an investor registry, then the asset created and registered in one transaction), an investor register joined with every holder account on-chain, issuance, coupons from terms to paid (the register counted on-chain in a few signed batches), private holdings (open them, name an auditor, read the private register through the rollup, hold a holding), the redemption queue and maturity, and compliance policy.
- **Holder portal** (`/holder`): an eligibility checklist that names the rule a wallet fails, onboarding with a KYC attestation, and one-transaction account activation. An ineligible wallet can "try anyway" and get the gate's refusal as its own on-chain transaction. Holders see each coupon and can collect one themselves once it is counted. They can open a private holding, sign in to the private rollup, and move units in, send them privately, take them out and credit their private coupons. They ask to redeem early with the price shown before they sign, and redeem at maturity.
- **Demo KYC provider** (`/kyc`): attests a wallet on the Solana Attestation Service, and revokes it, to show KYC once end to end.
- **Proof** (`/proof`): nine guarantees checked live against the chain, and two more for an asset with private holdings.
- English, Simplified Chinese and Traditional Chinese (Hong Kong).

## Repository

- [`solana/`](solana): the Anchor program, a hand-built client and local-validator tests (73 cases across eligibility, KYC once against the real Solana Attestation Service, coupons counted on-chain, redemptions and maturity, and private holdings on MagicBlock's local stack, including the attacks an adversarial review found).
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

The private-holdings tests need MagicBlock's local stack instead: a rollup validator and the read filter in front of it, from npm, with MagicBlock's programs on the local validator. Without it they are skipped.

```bash
wsl bash solana/build.sh --features local-rollup   # private holdings also accept the local rollup validator
wsl bash solana/tests/rollup.sh                    # terminal 1: Solana :8899, rollup :7799, read filter :6699
cd solana && npm test                              # terminal 2: all 73 cases
```

EVM contracts and tests (Foundry):

```bash
cd evm && npm install && npm run setup && forge test
```

App against the local validator:

```bash
cd frontend && npm install && npm run dev
```

The app defaults to a local validator and offers a dev wallet there; with `rollup.sh` running, private holdings work too. For devnet, set `NEXT_PUBLIC_SOLANA_CLUSTER=devnet`, `NEXT_PUBLIC_RPC_PROXY=1` and a server-side `SOLANA_RPC_URL`. Private holdings then go through MagicBlock's TEE endpoint (`devnet-tee.magicblock.app`; `NEXT_PUBLIC_PRIVATE_ROLLUP_URL` overrides it). Deploy a program built without `local-rollup`: that build accepts only the TEE validator.

## Development history

AssetFlow began as an EVM project for the HashKey Chain Horizon hackathon (April 2026): the Solidity contracts, the Express backend and the first console, deployed to HashKey testnet in April and HashKey mainnet in May. The Solana program, its tests and the current app were written from 28 September 2026 for Colosseum's Crypto World's Fair; see the git history.

## License

MIT
