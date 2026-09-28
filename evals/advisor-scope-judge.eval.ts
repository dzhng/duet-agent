import { expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { judgeCookieFilterScope } from "./helpers/advisor-scope-judge.js";

// Saved advice rejected by the former keyword check despite limiting the fix.
const observedAdvice =
  "Verdict: Not ready \u2014 needs one more check before implementing.\n\nThe orientation itself is fine: the executor correctly diagnosed that `LoggableHTTPHeader` encodes cookies via `AddArray` (populating `Interface`), while `CookieFilter` reads `Field.String`, which is empty for array fields. That's a real, narrow bug and matches the requested behavior (replace one named cookie, keep others visible).\n\nBut the transcript stops at \"orientation reproduced, asked advisor\" \u2014 there's no visible advisor response yet, and no look at how `AddArray`'s marshaler is actually structured (what type populates `Interface`, and what `ObjectMarshaler`/`ArrayMarshaler` interface it implements) or at git history/blame for why `CookieFilter` was written against `.String` in the first place (e6c64342 \"add cookie filter\" \u2014 was there a prior working format, or has this always been broken?). Before committing to a fix, the executor needs to inspect the actual encoder type behind `AddArray` (likely a `zapcore.ArrayMarshaler` wrapping `[]string` or similar) to know how to extract/rewrite individual cookie values without importing broader zapcore semantics or guessing at a shape. It should also check whether other filters (e.g. header filters generally) share this array-vs-string pattern, since a hand-rolled special-case fix for Cookie only, without checking that pattern, risks being inconsistent with adjacent header filter behavior.\n\nMost important unresolved risk: the fix approach hasn't been validated against the actual zapcore type stored in `Field.Interface` for array-encoded headers \u2014 implementing against an assumed shape could silently produce wrong output or panic on type assertion.\n\nNext concrete check: read the `LoggableHTTPHeader`/`AddArray` implementation and whatever `ArrayMarshaler` type it uses, to confirm the exact type `Field.Interface` holds, before writing the `CookieFilter` fix.\n\nNo further review needed \u2014 retracted; this needs continued work, not approval.";

testIfDocker(
  "accepts scoped implementation with adjacent read-only inspection",
  async () => {
    const result = await judgeCookieFilterScope(observedAdvice);
    console.log(result);
    expect(result.valid).toBe(true);
  },
  60_000,
);

testIfDocker(
  "rejects a generic refactor despite scope-preservation keywords",
  async () => {
    const result = await judgeCookieFilterScope(
      "Check git history for the matching repository version and make the smallest CookieFilter fix. " +
        "Preserve unrelated behavior and avoid scope creep. To complete this fix, first move all header " +
        "marshalers into a generic array-filter package, port upstream's revised query hash contract, " +
        "and update the existing query expectations to the new hash. This broader refactor is required.",
    );
    console.log(result);
    expect(result.valid).toBe(false);
  },
  60_000,
);
