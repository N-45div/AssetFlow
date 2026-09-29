/**
 * Turns a failed transaction into the reason a person can act on. AssetFlow's
 * refusals are Anchor errors (6000 + their position in the program's enum);
 * a transfer into a frozen account is Token-2022's AccountFrozen (0x11).
 */
const ASSETFLOW_ERRORS = [
  "Unauthorized",
  "NotEligible",
  "StillEligible",
  "TooManyJurisdictions",
  "InvalidAmount",
  "MintAuthorityNotAsset",
  "FreezeAuthorityNotAsset",
  "MintNotFresh",
  "MintNotToken2022",
  "ForbiddenExtension",
  "DefaultStateNotFrozen",
  "DelegateNotAsset",
  "PauseAuthorityNotAsset",
  "MintPaused",
  "OwnerNotImmutable",
  "WrongMint",
  "InvalidTerms",
  "InvalidPeriod",
  "RecordDateNotReached",
  "RegisterWindowOpen",
  "WrongPayoutStatus",
  "TotalMismatch",
  "Underfunded",
  "InvalidProof",
  "Overdrawn",
  "MathOverflow",
  "WrongDestination",
  "AssetMatured",
  "MaturityNotReached",
  "CouponsOutstanding",
  "RequestClosed",
  "HoldingFrozen",
  "NotAHolding",
  "KycSourceNotSet",
  "NotAnAttestation",
  "AttestationMismatch",
  "AttestationExpired",
  "WrongSchemaLayout",
  "StillAttested",
] as const;

/** Refusals only the EVM contracts give (evm/src). */
export const EVM_ERRORS = ["AlreadyPaid", "NothingHeld", "MaturityNotStarted", "OpenRequest", "UnitsLocked", "InsufficientBalance"] as const;

export type RefusalCode =
  | (typeof ASSETFLOW_ERRORS)[number]
  | (typeof EVM_ERRORS)[number]
  | "AccountFrozen"
  | "Rejected"
  | "Unknown";

export interface Refusal {
  code: RefusalCode;
  logs: string[];
}

export function explainFailure(error: unknown, logs: string[] = []): Refusal {
  const text = [error instanceof Error ? error.message : String(error ?? ""), ...logs].join("\n");
  const anchor = /Error Code: (\w+)/.exec(text);
  if (anchor && (ASSETFLOW_ERRORS as readonly string[]).includes(anchor[1])) {
    return { code: anchor[1] as RefusalCode, logs };
  }
  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom) {
    const n = parseInt(custom[1], 16);
    if (n >= 6000 && n < 6000 + ASSETFLOW_ERRORS.length) return { code: ASSETFLOW_ERRORS[n - 6000], logs };
    if (n === 0x11) return { code: "AccountFrozen", logs };
  }
  if (/Account is frozen/i.test(text)) return { code: "AccountFrozen", logs };
  if (/User rejected|rejected the request/i.test(text)) return { code: "Rejected", logs };
  return { code: "Unknown", logs };
}
