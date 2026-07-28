/**
 * The virtual tier this process is currently routing under, or undefined when
 * a concrete model is pinned.
 *
 * Deliberately an opaque string. Tier names come from the active routing table
 * — the built-in default or a `.duet/models.json` replacement — and can change
 * without an agent release, so nothing here may enumerate or validate them.
 * The agent reports which tier it is routing under; deciding what that tier
 * means belongs to whoever owns the table.
 */
let activeTier: string | undefined;

/** Tier name to attribute duet-gateway calls to, if any. */
export function activeDuetTier(): string | undefined {
  return activeTier;
}

/**
 * Record the routing tier, or clear it for a concrete pin.
 *
 * Callers pass the tier only after checking the name against the *active*
 * table, so a long-lived process cannot inherit a stale tier across a pin.
 */
export function setActiveDuetTier(tier: string | undefined): void {
  activeTier = tier;
}
