/** Built-in virtual tiers accepted by the product-facing routing contract. */
export const DUET_MODEL_TIERS = ["frontier", "balanced", "economy"] as const;

/** Product-facing virtual tier whose gateway calls carry billing attribution. */
export type DuetModelTier = (typeof DUET_MODEL_TIERS)[number];

let activeTier: DuetModelTier | undefined;

/** Current process-scoped tier, absent whenever the process is concretely pinned. */
export function activeDuetTier(): DuetModelTier | undefined {
  return activeTier;
}

/** True only for the three product-owned virtual tier ids. */
export function isDuetModelTier(value: string | undefined): value is DuetModelTier {
  return DUET_MODEL_TIERS.some((tier) => tier === value);
}

/**
 * Update gateway attribution from the effective model selection.
 *
 * Concrete pins and non-routing commands clear the holder so a long-lived
 * process cannot inherit a prior routed tier.
 */
export function setActiveDuetTierFromModelSelection(modelName: string | undefined): void {
  activeTier = isDuetModelTier(modelName) ? modelName : undefined;
}
