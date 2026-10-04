# Security notes: AssetFlow's EVM contracts

What the contracts guarantee, how they are tested, and what static analysis found. The contracts have **not**
been audited; do not use them for real investor money until they are.

## The contracts

| Contract | Role |
|---|---|
| `Registry` | The issuer's policy (jurisdictions, minimum tier, accreditation) and every investor's profile. KYC once: a profile can be claimed from an Ethereum Attestation Service attestation by an attester the registry trusts. |
| `ServicedToken` | ERC-20 that checks `Registry.isEligible` on **every** transfer and mint, keeps each balance and the total supply as timestamped checkpoints, and locks units under redemption requests. |
| `Servicer` | The bond: terms, coupons, early redemptions, maturity. Creates its own token. Pays in any ERC-20 (Paxos's USDG, USDC, a test dollar). |
| `DayCount` | 30/360 day count, a port of the Solana program's. |
| `Directory` | Lists registries and bonds per issuer, for the console. |

## Guarantees and how they are enforced

- **Only eligible wallets hold units.** `ServicedToken._update` asks the registry on every mint and transfer, so a lapsed approval or a compliance hold stops the holder's next transfer outright.
- **Coupons follow the register at the record date.** Each holder's coupon is computed from `balanceAt(holder, recordTs)`, read from the token's own checkpoints. Nobody commits a register, and nothing is paused to take one.
- **Payouts cannot exceed what was funded.** `Servicer` tracks funded, paid and held-back amounts per period and per maturity, and every payment checks `paid + amount <= funded` (`Overdrawn`).
- **Ineligible holders are held back, not paid.** Their coupon stays in the contract and is reported as held back.
- **No arithmetic wraps.** Solidity 0.8 checked arithmetic, plus OpenZeppelin `SafeCast` for every narrowing cast.
- **Token transfers are safe and reentrancy-guarded.** OpenZeppelin `SafeERC20` for the payment currency; `ReentrancyGuard` on every function that moves it. Amounts received are measured from balances, so fee-on-transfer currencies cannot overstate funding.
- **Redemptions are priced by the contract,** at face plus interest accrued to the day of settlement, and the units burn in the same transaction as the payment.
- **Maturity ends issuance.** Once maturity starts, the token can no longer be minted.

## Tests

`forge test` runs 19 tests (`test/AssetFlow.t.sol`), including a fuzz test that coupon parts never exceed the whole,
the register at a record date read from checkpoints, eligibility on transfer, held-back coupons, redemption pricing,
maturity, and KYC once against the real EAS 1.4 contracts from npm.

## Static analysis (Slither 0.11.6)

Run on Oct 4, 2026 over `src/` (libraries, tests and scripts excluded, informational and optimization detectors off):
**0 high, 9 medium, 19 low.** Each was reviewed:

| Finding | Count | Where | Assessment |
|---|---|---|---|
| divide-before-multiply | 5 | `DayCount.civilFromDays` | Intended: the standard days-to-civil-date algorithm relies on integer (floor) division. |
| unused-return | 3 | `ServicedToken._update` | `Checkpoints.push` returns the previous and new values, which are not needed. |
| incorrect-equality | 1 | `Servicer.redeem` | `units == 0` is a plain zero-balance check; there is no rounding to exploit. |
| missing-zero-check | 5 | `Registry`, `ServicedToken` constructors and setters | `setKycSource(…, 0)` is documented as "trust no provider". The constructors are called by the `Servicer` and the console with known addresses. `setCompliance(0)` is recoverable: the admin can set it again. |
| calls-loop | 4 | `Servicer.pay`, `payMany`, `required` | The calls go only to the bond's own token and registry; the caller bounds the batch size. |
| reentrancy-benign / reentrancy-events | 3 | `Servicer.requestRedemption`, `_return` | The external call is to the bond's own token, which makes no callbacks; the functions are `nonReentrant` where currency moves. |
| timestamp | 7 | record dates, KYC expiry, maturity | Inherent: these rules are defined by time. A validator's few seconds of drift do not change a record date's register. |

No finding called for a code change.

## Deployments

All deployed contracts are recorded in [`deployments/`](deployments); the shared contracts (directory, test dollar, the
mainnet pilot notes, and the EAS contracts AssetFlow deployed on Robinhood Chain) are verified on Sourcify. Registries
and bonds that issuers deploy from the console use the same compiled bytecode as `src/`.
