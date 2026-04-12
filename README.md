# AssetFlow

`AssetFlow` is a HashKey Chain-native backend and smart contract stack for servicing tokenized assets after issuance.

It focuses on the workflow most hackathon demos skip:

- compliance-gated transfers
- investor eligibility management
- issuer-declared distributions
- redemption request queues
- audit-friendly servicing events

The MVP is designed for HashKey Chain's institutional and RWA positioning:

- EVM-compatible deployment on HashKey Chain
- optional integration point for an external KYC oracle or SBT adapter
- Safe-friendly issuer admin model
- merkle-root distributions that can be generated from backend snapshots or subgraph data

## Layout

- [`contracts/`](/home/divij/vincent/assetflow/contracts): Hardhat package for AssetFlow contracts
- [`backend/`](/home/divij/vincent/assetflow/backend): API server and servicing helpers
- [`docs/`](/home/divij/vincent/assetflow/docs): architecture and contract notes

## Verified HashKey Assumptions

These were checked against official docs before building:

- HashKey Chain testnet RPC: `https://testnet.hsk.xyz`, chain ID `133`
- HashKey Chain mainnet RPC: `https://mainnet.hsk.xyz`, chain ID `177`
- HashKey provides KYC tooling and Safe support in its builder docs
- HashKey supports Subgraph indexing on `hashkeychain`, which fits the merkle snapshot flow


## Real Vs Demo Components

The core protocol contracts are the real product path:

- `ComplianceRegistry`
- `ServicedAssetToken`
- `DistributionModule`
- `RedemptionModule`

The only replaceable demo dependency is the payout asset:

- on testnet, you can use native `HSK` by setting `USE_NATIVE_SETTLEMENT=true`
- on testnet, you can point `SETTLEMENT_TOKEN_ADDRESS` at a real ERC-20 if you already have one
- if you do not, the deploy script will deploy `MintableSettlementToken` as a demo settlement asset

That means the servicing flow is real on HashKey testnet either way. The only question is whether the payout token is an existing asset or a demo asset you control.

## Quick Start

```bash
cd /home/divij/vincent/assetflow/contracts
npm install
npm run compile
npm test

cd /home/divij/vincent/assetflow/backend
npm install
npm start
```

## Smart Contract Design

- `ComplianceRegistry`: issuer-controlled investor policy layer with jurisdiction, tier, accreditation, freeze state, and an optional external eligibility oracle hook for HashKey-specific KYC adapters.
- `ServicedAssetToken`: restricted ERC-20 for the serviced asset. Transfers, issuance, and servicing flows check the compliance registry.
- `DistributionModule`: issuer-funded payout contract using merkle roots for snapshot distributions. This keeps cap-table generation off-chain while leaving claims and funds on-chain.
- `RedemptionModule`: queue for redemption requests, issuer approval, and final settlement against a configured payout token.
- `AssetOracleRouter`: oracle-backed valuation module for redemption quotes using Aggregator-style feeds such as the HashKey-documented APRO and Chainlink-style interfaces.

## Backend Scope

Current API coverage:

- investor compliance lookup and profile updates
- jurisdiction whitelisting
- snapshot generation with merkle proofs
- distribution publication
- claim proof lookup and unsigned claim intents
- redemption read/approve/settle flows
- unsigned redemption request intents
- oracle-backed redemption quote reads via `/oracle/redemption-quote`

## Oracle Notes

The oracle path is implemented but intentionally decoupled from settlement:

- `AssetOracleRouter` quotes asset value and redemption value
- `RedemptionModule` still settles the approved payout amount explicitly

That split is deliberate for the hackathon demo:

- servicing is already live and deployed on testnet
- oracle valuation can be added without forcing settlement semantics too early
- different RWAs may need different feeds, heartbeats, and stale thresholds

Useful official HashKey oracle references:

- SUPRA testnet pull oracle: `0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702`
- APRO testnet USDC/USD: `0xCdB10dC9dB30B6ef2a63aB4460263655808fAE27`
- APRO testnet USDT/USD: `0xC45D520D18A465Ec23eE99A58Dc4cB96b357E744`
- Chainlink Streams verifier proxy testnet: `0xE02A72Be64DA496797821f1c4BB500851C286C6c`

Source: [HashKey Oracle Docs](https://docs.hashkeychain.net/docs/Build-on-HashKey-Chain/Tools/Oracle)

## Deploy To HashKey Testnet

1. Configure env in [`contracts/.env.example`](/home/divij/vincent/assetflow/contracts/.env.example):

```bash
cd /home/divij/vincent/assetflow/contracts
cp .env.example .env
```

Required:

- `PRIVATE_KEY`: deployer key funded with testnet HSK gas

Optional:

- `ADMIN_PRIVATE_KEY`: required if `ADMIN_ADDRESS` is different from the deployer
- `ADMIN_ADDRESS`: multisig or admin wallet
- `ISSUER_ADDRESS`: issuer operator wallet
- `USE_NATIVE_SETTLEMENT=true`: use native `HSK` for distributions and redemptions
- `SETTLEMENT_TOKEN_ADDRESS`: existing ERC-20 on testnet
- `DEFAULT_JURISDICTION`: defaults to `344`

2. Compile:

```bash
npm run compile
```

3. Deploy:

```bash
npm run deploy:testnet
```

4. Take the printed addresses and copy them into [`backend/.env.example`](/home/divij/vincent/assetflow/backend/.env.example).

5. Start the backend:

```bash
cd /home/divij/vincent/assetflow/backend
cp .env.example .env
npm install
npm start
```

If you want to protect issuer/admin routes in the live demo, set:

- `ADMIN_API_KEY`
- `ADMIN_PRIVATE_KEY` and `ISSUER_PRIVATE_KEY` when you are operating split admin and issuer wallets
- `ADMIN_ADDRESS` and `ISSUER_ADDRESS` to make signer-role mismatches fail fast on startup

Then send that value as `x-admin-key` on:

- `/admin/*`
- `/redemptions/:requestId/approve`
- `/redemptions/:requestId/settle`

## Servicing Edge Cases

`RedemptionModule` now returns units with a dedicated servicing transfer path instead of a normal ERC-20 transfer.

That matters when:

- an investor becomes frozen after submitting redemption
- a KYC profile expires before issuer review
- a request must be rejected or cancelled during a compliance incident

Normal secondary transfer restrictions remain intact, but the issuer can still unwind the queued servicing position safely.
