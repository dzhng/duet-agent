// Pure visibility rule for the dino panel. Lives in its own file so tests
// can import it without dragging in OpenTUI (which the panel module
// pulls in at the top of `./index.ts`). Keeping this rule centralized
// means a regression that quietly makes the panel visible at rest fails
// a unit test instead of a manual dogfood pass.
//
// Contract:
//   - agent idle               → 0 rows (panel is invisible, reserves no
//                                vertical space).
//   - agent busy + collapsed   → 0 rows. The Ctrl-G tease lives in the
//                                input placeholder, not in a hint row.
//   - agent busy + expanded    → EXPANDED_ROWS rows (the full game).

import { COLLAPSED_ROWS, EXPANDED_ROWS } from "./render.js";

export function panelVisibleRowCount(expanded: boolean, agentBusy: boolean): number {
  if (!agentBusy) return 0;
  return expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
}
