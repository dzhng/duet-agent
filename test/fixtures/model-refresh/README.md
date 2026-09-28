# Model refresh qualification

The baseline fixture was produced by baseline commit
`6cb40aa5062f24aa2bde1971f9ea521440996175`, package `@duetso/agent@0.3.26`,
with its unchanged frozen lockfile. It is an actual Session envelope after a
successful controlled provider completion, not a hand-authored TurnState.
The saved alias loss is visible in each `selection`, persisted `options`, and
captured request. `other-families-baseline.json` captures Grok and GLM using
the same baseline archive and controlled provider seam. Actual assistant messages keep their original provider/model.

`capture-baseline.ts` is the capture source, moved here from the original
`scripts/model-refresh-baseline.ts` named in the immutable receipt. To reproduce,
extract the baseline commit into a scratch directory, copy this capture source
and `test/helpers/model-refresh-upstream.ts` into the matching paths there,
and run the capture in `oven/bun:1.3.11` with `HOME=/tmp/home`, the frozen
lockfile, and this fixture output directory mounted at `/out`. Never run the
capture against the user's home or against the updated source and call it a
baseline.

`model-refresh.test.ts` resumes these exact envelopes through the CLI config
builder and real Session/TurnRunner, completes a second turn against a controlled
HTTP provider, and checks saved family intent, new wire model ID, preserved
historical messages, and new assistant attribution. Initial red receipts showed
`opus-5` instead of `opus`, then `frontier` instead of the saved selection when
the normal CLI default was included. The corrected seam preserves provider choice and recognizes matching legacy
flags in generated resume commands. The user clarified that known replaced
concrete provider selections must advance too: historical CLI `--provider`
defaults are indistinguishable from advanced pins after canonicalization.
Only known replaced targets on supported transports advance at hydration;
unknown pins and different explicit overrides remain untouched. Fresh
`--provider` defaults retain provider:family intent instead of a concrete ID.

`gateway-catalog.json` and `openrouter-catalog.json` retain the primary catalog
records supporting model IDs, modalities, limits, reasoning, and cost metadata.
The former contains its original fetch timestamp/hash; the latter contains the
full source-response hash. These establish catalog contracts, not account
eligibility or live successful inference. Missing pi-ai specs clone shipped
transport implementations at the existing catalog boundary. Connected clones
retain conservative donor limits and existing transport preference.

Official connected-provider availability was separately checked at
<https://docs.github.com/en/copilot/reference/ai-models/supported-models> and
<https://learn.chatgpt.com/docs/changelog>. The capability-probe regression proves
an account listing only Opus 5.5 is tested with a model it lists; 402/403 and
transient-failure classification remain covered by the neighboring tests.

Media requests run through the real CLI and AI SDK in Docker. URL input had a
reproduced ENOENT before the fix. Controlled video output covers Seedance 2.5,
Veo 3.1, and Grok Imagine Video 1.5; Gemini's stable language-image path gets
controlled file output. This is serialization/output evidence, not live upstream
media-generation evidence. The product qualification also ran a bounded live Seedance 2.5 request through
the installed AI SDK using local PNG bytes: successful video output was
3,636,498 bytes after approximately 159 seconds. This execution evidence
overrides the catalog page’s URL-only caveat for the measured gateway path.
Custom FPS was warned unsupported; the provider uses fixed 24 FPS.

The independent Codex review found two actionable resume defects: missing
Grok/GLM aliases and shared SessionManager configuration leaking a resumed
selection into a sibling session. Both received failing behavior tests and were
fixed at the existing option hydration and session-construction boundaries.

Final focused Docker receipt: `oven/bun:1.3.11`, `HOME=/tmp/home`, frozen
lockfile; 61 tests passed across model refresh, media CLI, connected capability
probe, session model switching, and session/manager behavior. The resume test
completed fourteen new controlled turns: six family envelopes plus the actual
baseline `--provider duet` envelope, each with implicit resume and the legacy
flags printed by the old CLI. Falsifying provider normalization in the container
first failed on `duet-gateway:anthropic/claude-opus-5` versus the required
`duet-gateway:opus`; restoring it passed the focused suite. The complete package
gate runs on the clean release composition after cherry-picking this change,
so unrelated unpushed agent work is excluded from release.

An additional controlled request qualified a connected-account upgrade defect:
a valid Copilot token whose cached availability contained only Opus 5 dispatched
the new Opus target to the metered Duet gateway. The existing token startup seam
now requests one locked, coalesced availability refresh when its list contains a
known retired target without its successor. An account still denying the new
model keeps that denial; the attempt is consumed so ordinary turns do not poll.
The tradeoff is at most one extra OAuth/model-list refresh per CLI boot while
such an old-only list remains. No provider permission is inferred from the
catalog and no durable version field is added. Concurrent launch callers wait
for this refresh rather than using the still-valid old token. Controlled wire,
coalescing, and no-repeat tests passed after their failing reproductions.

The immutable `managed-routing-baseline.json` was emitted by Duet gateway
commit `9b2dee1eef0ef1d5a35a1d7e988846db30f3db6a` through its real
`MANAGED_ROUTING_TABLE` export, including provider overlays. The independently
updated published agent 0.3.27 rejected its retired Sol and Opus targets before
any request. The routing load regression proves that the next agent accepts
these bytes, dispatches current targets, and leaves the file and routing policy
unchanged. Agent and gateway update rails are independent; qualifying only an
old agent with a new gateway table misses this inverse ordering.

`retired-aliases-baseline.json` captures every spelling of the retired entries
from the last pre-refresh published catalog. Alias recovery must recognize those
spellings as well as their canonical names; it must not broaden the closed set
of retired models or reinterpret unknown custom-provider selectors.

The final combined review qualified two selection-precedence defects beyond
routing-file compatibility. Normalizing every runtime base also reinterpreted
a newly supplied advanced provider pin; normalization now belongs only to saved
state hydration and routing-file load. The CLI's resume overrides omit implicit
models, but a later clear still needs the original fresh-launch defaults. The
terminal-boundary regression drives the actual CLI through resume and clear,
including project routing and explicit flags, without rendering a desktop UI.

Saved workflow definitions are executable input; definition snapshots in their
history are audit data. Recovery advances the former without rewriting the
latter. The controlled workflow regression resumes both an uninstantiated
explicit workflow and an active workflow through real child-model requests.
Custom chat tiers shadow catalog spellings on parent and state-agent selections;
memory actors instead require concrete catalog selections. The collision
regression verifies that this distinction survives session hydration.
