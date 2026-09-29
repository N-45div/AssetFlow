import type { InvestorProfile, Registry } from "./program";

/** What the rules read: a registry's policy and a profile, on any chain. */
export type Policy = Pick<Registry, "minTier" | "requireAccredited" | "jurisdictions">;
export type ProfileFields = Pick<InvestorProfile, "approved" | "accredited" | "frozen" | "tier" | "jurisdiction" | "expiry">;

export type RuleId = "profile" | "approved" | "hold" | "expiry" | "tier" | "jurisdiction" | "accredited";

export interface RuleResult {
  id: RuleId;
  pass: boolean;
  /** Not applicable: shown, but never the reason for a refusal. */
  skipped?: boolean;
}

/**
 * The same six rules Registry::admits applies on-chain, evaluated here so the
 * portal can say which one a wallet fails instead of a bare "not eligible".
 */
export function checkEligibility(
  registry: Policy,
  profile: ProfileFields | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): { eligible: boolean; rules: RuleResult[] } {
  if (!profile) {
    return { eligible: false, rules: [{ id: "profile", pass: false }] };
  }
  const rules: RuleResult[] = [
    { id: "profile", pass: true },
    { id: "approved", pass: profile.approved },
    { id: "hold", pass: !profile.frozen },
    { id: "expiry", pass: profile.expiry >= nowSeconds },
    { id: "tier", pass: profile.tier >= registry.minTier },
    { id: "jurisdiction", pass: registry.jurisdictions.includes(profile.jurisdiction) },
    {
      id: "accredited",
      pass: !registry.requireAccredited || profile.accredited,
      skipped: !registry.requireAccredited,
    },
  ];
  return { eligible: rules.every((r) => r.pass), rules };
}
