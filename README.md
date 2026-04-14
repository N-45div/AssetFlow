# AssetFlow

**The transfer-agent and fund-administration layer for tokenized assets on HashKey Chain.**

AssetFlow is built for the part of tokenized finance that most demos skip. Issuance is only the start. Once a fund unit, note, commodity-backed token, or private placement asset is live, someone still has to operate it:

- decide who is allowed to hold it
- manage transfer restrictions
- prepare payout windows
- service holder claims
- review redemptions
- settle exits with an auditable workflow

AssetFlow turns that post-issuance servicing layer into a product.

## What AssetFlow Does

AssetFlow gives issuers and operators a live workflow for running tokenized assets after launch.

The product combines:

- **holder eligibility controls**
  Wallets can be approved, frozen, expired, jurisdiction-gated, and tiered for compliant access.

- **restricted asset servicing**
  The serviced asset token is policy-aware, not just mintable.

- **payout window infrastructure**
  Issuers generate snapshots off-chain, publish merkle-root distributions on-chain, and let holders claim against a verifiable payout window.

- **redemption queue operations**
  Holders request exit, issuers review and approve or reject, and settlement is completed through a controlled on-chain process.

- **valuation visibility**
  Oracle-backed quote reads support redemption pricing checks before settlement.

## Why This Matters

Most tokenized asset products focus on issuance, access, or trading. The operational burden after launch still falls back to fragmented off-chain tooling: spreadsheets, manual payout coordination, admin portals, and internal reconciliation.

That makes tokenized assets hard to run like real financial products.

AssetFlow focuses on the missing layer:

- who can hold the asset
- when it pays out
- how claims are serviced
- how exits are reviewed
- how the issuer stays in control

## Who It Is For

AssetFlow is designed for teams issuing or operating:

- tokenized funds
- tokenized notes or structured products
- commodity-backed tokens
- private placement or restricted-access RWAs

In hackathon form, it is best understood as **on-chain servicing infrastructure for compliant tokenized assets**.

## Product Surface

AssetFlow ships as a three-part stack:

### 1. On-chain contracts

- `ComplianceRegistry`
- `ServicedAssetToken`
- `DistributionModule`
- `RedemptionModule`
- `AssetOracleRouter`

These contracts handle policy, asset servicing, distributions, redemptions, and quote reads.

### 2. Backend API

The backend powers issuer/operator actions:

- investor approval and policy updates
- minting
- snapshot construction
- payout publication
- claim proof lookup
- redemption read/approve/reject/settle actions
- oracle quote reads

### 3. Frontend

The Next.js frontend has two routes:

- `/`
  Product framing and positioning
- `/console`
  Guided operator workflow for servicing the asset

## Live Demo Narrative

The demo is intentionally simple:

1. connect the console to the live backend
2. show that the issuer can approve who may hold the asset
3. issue units to approved holders
4. prepare and publish a payout window
5. generate a claim packet for a holder
6. inspect and resolve a redemption request
7. run an oracle-backed valuation quote

The point of the demo is not “look, another dashboard.”

The point is:

**this tokenized asset can now be operated like a product, not just minted like a token.**

## Why HashKey Chain

AssetFlow is built specifically for HashKey Chain's strongest narrative:

- compliance-aware on-chain finance
- institutional-grade tokenized assets
- RWA infrastructure
- oracle-backed settlement context
- EVM-compatible deployment path

HashKey Chain is a strong fit for post-issuance servicing because the chain already leans toward regulated and institution-facing financial infrastructure rather than generic retail DeFi.

## Current Deployment

HashKey testnet:

- `ComplianceRegistry`: `0xC6234816f981C0bC8E8FB48Ba6FF9fb864212f3c`
- `ServicedAssetToken`: `0x4372222b90612bCD37e09452052DE5b44DfBC10C`
- `DistributionModule`: `0xE6ab32D718AFe5932c7805c231AD35A6133Aa383`
- `RedemptionModule`: `0x367a53A6728771E66f9e430932D7FA75B446fA0a`
- `OracleRouter`: `0xD22602E3114b754a86583ce2d48Cce05d2becd78`

Hosted backend:

- `https://assetflow-backend-1064261519338.us-central1.run.app`

## Repository Layout

- [`contracts/`](/home/divij/vincent/assetflow/contracts)
  Hardhat contracts, deployment scripts, and integration tests
- [`backend/`](/home/divij/vincent/assetflow/backend)
  Express API, chain integration, and demo state
- [`frontend/`](/home/divij/vincent/assetflow/frontend)
  Next.js landing page and servicing console
- [`ARCHITECTURE.md`](/home/divij/vincent/assetflow/ARCHITECTURE.md)
  System and demo diagrams

## Run It Locally

### Contracts

```bash
cd /home/divij/vincent/assetflow/contracts
npm install
npm run compile
npm test
```

### Backend

```bash
cd /home/divij/vincent/assetflow/backend
npm install
cp .env.example .env
npm start
```

### Frontend

```bash
cd /home/divij/vincent/assetflow/frontend
npm install
npm run dev
```

## Deploy To HashKey Testnet

```bash
cd /home/divij/vincent/assetflow/contracts
cp .env.example .env
npm run compile
npm run deploy:testnet
```

Then wire the deployed addresses into the backend env and start the API.

## Product Framing

If you need the shortest accurate description of AssetFlow, use this:

> AssetFlow is the transfer-agent and fund-administration layer for tokenized assets on HashKey Chain.

If you need the slightly longer version:

> AssetFlow handles the operational layer after tokenization: holder eligibility, payout servicing, redemption workflow, and oracle-backed valuation visibility.
