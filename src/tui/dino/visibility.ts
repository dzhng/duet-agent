// Pure visibility rule for the dino panel. Lives in its own file so tests
// can import it without dragging in OpenTUI (which the panel module
// pulls in at the top of `./index.ts`). Keeping this rule centralized
// means a regression that quietly steals rows at rest fails a unit test
// instead of a manual dogfood pass.
//
// Contract:
//   - collapsed   → 0 rows. The Ctrl-G tease lives in the input
//                   placeholder, not in a reserved hint row, so the
//                   transcript bottom stays flush with the sidebar.
//   - expanded    → EXPANDED_ROWS rows. Ctrl-G is a user-driven toggle
//                   that works whether or not the agent is currently
//                   busy; the input placeholder already tells the user
//                   they can hit it any time.

import { COLLAPSED_ROWS, EXPANDED_ROWS } from "./render.js";

export function panelVisibleRowCount(expanded: boolean): number {
  return expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
}
