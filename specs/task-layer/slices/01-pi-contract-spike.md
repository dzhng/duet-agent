# 01 — pi-contract spike (verdict gate)

**Contract unlocked:** test-pinned answers to how the vendored loop (pi-agent-core 0.79.10,
read-only) behaves under the mechanics the whole design leans on. Doubles as an upgrade
tripwire for any future pi bump.

**Seam:** no product code. New `test/pi-loop-contract.test.ts` driving `agentLoop` from
`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` with a scripted `streamFn`
and stub tools.

**Pin these five behaviors (each red-then-green):**

1. A steer queued during a `terminate: true` batch revives the inner loop (agent-loop.js ~:154).
2. A followUp revives the outer loop (~:157-165).
3. `clearAllQueues()` + asserting queues-empty at run start makes terminate actually terminal.
4. One `executionMode: "sequential"` tool serializes the WHOLE batch (~:255-260) — including
   the other tools' prepare phase; characterize the cost.
5. A tool whose execute resolves early while its inner promise continues leaves pi clean —
   and emitting through the agent after `agent_end` throws ("listener invoked outside active
   run", agent.js ~:393). The orphaned promise must be fully detached from pi's emit and the
   run signal.

**Run:** `bun test pi-loop-contract`.

**Verdict gate — STOP criteria:** if (3) or (5) fail, the settlement-queue and
budget-conversion designs are invalid. Halt, reopen the architecture with the user; do not
work around it.

**Must stay green:** everything (no product changes).

**Feedback that would change this slice:** none expected — it is evidence-gathering.
