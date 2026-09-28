# AssetFlow

**The servicing layer for tokenized assets: who may hold them, what each holder is owed on the record date, and how they redeem, enforced on-chain and run from one console.**

Issuance is day one. A tokenized bond or fund still has to be run every day after: holder eligibility, transfer restrictions, coupons and dividends, redemptions, maturity. Today that work lives in spreadsheets and email next to a token on-chain. AssetFlow puts it where the token is.

Live app (Solana devnet): **https://assetflow-hashkey.vercel.app**

## Where it runs

| Chain | Status | What is there |
|---|---|---|
| **Solana** | Devnet | The servicing layer, built natively on Token-2022 and Token ACL (sRFC-37). Program `BWDCF6dLYETPYquDGKm8X6pyLnMZGhisporuTbozjtwR`. |
| **HashKey Chain** | Mainnet (chain 177), deployed 11 May 2026 | The EVM contracts AssetFlow started as: [ComplianceRegistry](https://hsk.blockscout.com/address/0xd06ea0b9AD8935df0e823555F0433604B880711D), [ServicedAssetToken "AssetFlow Pilot Unit"](https://hsk.blockscout.com/address/0x59E0f69FF6d25b5ceE757c874adAdC42E9857f2A), [DistributionModule](https://hsk.blockscout.com/address/0x93995825CA13fBbf74f6876480bf7565f33a8717), [RedemptionModule](https://hsk.blockscout.com/address/0x7495d785B5edA74E2c3ebc4B4c0909DeF86078bB). Recorded in [`contracts/deployments/hashkey-mainnet.json`](contracts/deployments/hashkey-mainnet.json). |
| Base, Arbitrum, Robinhood Chain | Planned | Tokenized stocks there reinvest dividends through a multiplier and never pay cash; AssetFlow is the cash-payout rail. One register, the same record-date payout published on each chain. |

## How it works on Solana

**Eligibility without a transfer hook.** The asset is a Token-2022 mint whose holder accounts start frozen (Default Account State). Token ACL, the Solana Foundation's sRFC-37 program, holds the freeze authority and asks the AssetFlow program, as the mint's *gate*, before any thaw or freeze:

- a holder can thaw their own account only if their investor profile passes the registry: approved, KYC in date, allowed jurisdiction, sufficient tier, accreditation where required;
- anyone can freeze a holder who no longer passes, so a lapsed approval is enforceable without the issuer;
- nobody can freeze a holder in good standing.

A plain Token-2022 transfer runs none of AssetFlow's code, so every wallet and program that handles Token-2022 handles the asset.

**No personal key can reach around the gate.** Every authority over the mint, including mint, freeze via Token ACL, pause and permanent delegate, belongs to the asset account, a PDA of the program. Registration is one step that checks how the mint is built (holder accounts frozen by default, no transfer hook, close authority, confidential transfers or fees) and hands the freeze authority to Token ACL itself. The gate thaws only accounts whose owner can never change, and issuance re-checks eligibility.

The public [proof page](https://assetflow-hashkey.vercel.app/proof) reads each of these guarantees back from the chain and links to the account that proves it.

**In progress:** instrument terms on-chain and coupons paid on the record date, with every amount computed by the program (30/360, rounded down to the cent on each holder's total holding), redemptions at a program-computed price with burn and USDC payment in one transaction, and maturity.

## The app

- **Issuer console** (`/issuer`): self-serve set-up (an investor registry, then the asset created and registered in one transaction), an investor register joined with every holder account on-chain, issuance, and compliance policy.
- **Holder portal** (`/holder`): an eligibility checklist that names the rule a wallet fails, and one-transaction account activation. An ineligible wallet can "try anyway" and get the gate's refusal as its own on-chain transaction.
- **Proof** (`/proof`): nine guarantees checked live against the chain.
- English, Simplified Chinese and Traditional Chinese (Hong Kong).

## Repository

- [`solana/`](solana): the Anchor program, a hand-built client and local-validator tests (18 cases, including the attacks an adversarial review found).
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

App against the local validator:

```bash
cd frontend && npm install && npm run dev
```

The app defaults to a local validator and offers a dev wallet there. For devnet, set `NEXT_PUBLIC_SOLANA_CLUSTER=devnet`, `NEXT_PUBLIC_RPC_PROXY=1` and a server-side `SOLANA_RPC_URL`.

## Development history

AssetFlow began as an EVM project for the HashKey Chain Horizon hackathon (April 2026): the Solidity contracts, the Express backend and the first console, deployed to HashKey testnet in April and HashKey mainnet in May. The Solana program, its tests and the current app were written from 28 September 2026 for Colosseum's Crypto World's Fair; see the git history.

## License

MIT
