import { describe, expect, test } from "bun:test";
import {
  verifySearchOutcome,
  verifyReleaseOutcome,
  createWorkflowProvider,
  workflowSearchProbes,
} from "../evals/fixtures/workflow-reliability/oracle.js";

describe("workflow outcome oracle", () => {
  test("rejects plausible results that never used the independent provider", () => {
    const probes = [
      {
        category: "people" as const,
        query: "engineers in Berlin",
        nonce: "fresh-people",
        expectedIds: ["person-ada"],
      },
      {
        category: "jobs" as const,
        query: "remote engineering jobs",
        nonce: "fresh-jobs",
        expectedIds: ["job-platform"],
      },
      {
        category: "people" as const,
        query: "volcanologists on Neptune",
        nonce: "fresh-empty",
        expectedIds: [],
      },
    ];
    const responses = probes.map((probe) => ({
      ...probe,
      status: 200,
      body: { ids: probe.expectedIds, nonce: probe.nonce },
    }));
    expect(
      verifySearchOutcome({ probes, responses, providerCalls: [], unchangedFiles: [] }).failures,
    ).toContain("No successful provider call for fresh-people");
    expect(
      verifySearchOutcome({
        probes,
        responses,
        providerCalls: probes.map((probe) => ({ ...probe, status: 200, ids: probe.expectedIds })),
        unchangedFiles: [],
      }).failures,
    ).toEqual([]);
  });
});

test("release proof requires an existing commit, matching artifact, and preserved scope", () => {
  const proof = {
    recordedSha: "a".repeat(40),
    commitSha: "a".repeat(40),
    committedSource: "correct search",
    releasedSource: "correct search",
    behaviorFailures: [],
    correctionPersisted: true,
    unchangedFiles: [{ path: "display.ts", before: "original", after: "original" }],
  };
  expect(verifyReleaseOutcome(proof).failures).toEqual([]);
  expect(verifyReleaseOutcome({ ...proof, commitSha: null }).failures).toContain(
    "Recorded commit does not exist or differs from release SHA",
  );
  expect(verifyReleaseOutcome({ ...proof, releasedSource: "stale search" }).failures).toContain(
    "Released source differs from committed source",
  );
  expect(
    verifyReleaseOutcome({
      ...proof,
      unchangedFiles: [{ path: "display.ts", before: "original", after: "unrequested repair" }],
    }).failures,
  ).toContain("Out-of-scope file changed: display.ts");
});

test("the oracle rejects empty probe sets", () => {
  expect(
    verifySearchOutcome({ probes: [], responses: [], providerCalls: [], unchangedFiles: [] })
      .failures,
  ).toContain("Search proof has no probes");
});

test("provider proof is query-specific and corrupted populated results fail", async () => {
  const probes = workflowSearchProbes();
  const provider = createWorkflowProvider();
  const responses = [];
  for (const probe of probes) {
    const response = await provider.fetch(
      new Request("http://provider/", {
        method: "POST",
        body: JSON.stringify(probe),
      }),
    );
    responses.push({ nonce: probe.nonce, status: response.status, body: await response.json() });
  }
  const evidence = { probes, responses, providerCalls: provider.calls, unchangedFiles: [] };
  expect(verifySearchOutcome(evidence).failures).toEqual([]);
  expect(
    verifySearchOutcome({
      ...evidence,
      responses: responses.map((response) => ({
        ...response,
        body: { ids: [], nonce: response.nonce },
      })),
    }).failures,
  ).toContain(`Incorrect search response for ${probes[0]!.nonce}`);
  expect(
    verifySearchOutcome({
      ...evidence,
      providerCalls: provider.calls.map((call) => ({ ...call, query: "another query" })),
    }).failures,
  ).toContain(`No successful provider call for ${probes[0]!.nonce}`);
  const unavailable = createWorkflowProvider(true);
  const response = await unavailable.fetch(
    new Request("http://provider/", { method: "POST", body: JSON.stringify(probes[0]) }),
  );
  expect(response.status).toBe(503);
  expect(verifySearchOutcome({ ...evidence, providerCalls: unavailable.calls }).failures).toContain(
    `No successful provider call for ${probes[0]!.nonce}`,
  );
});

test("provider probes with no JSON body return HTTP errors rather than crashing the harness", async () => {
  const provider = createWorkflowProvider();
  expect((await provider.fetch(new Request("http://provider/"))).status).toBe(405);
  expect(
    (await provider.fetch(new Request("http://provider/", { method: "POST", body: "bad json" })))
      .status,
  ).toBe(400);
  expect(provider.calls).toEqual([]);
});

test("a fifth unchanged execution fails the recovery outcome even across alternating states", async () => {
  const { verifyWorkflowRetries } =
    await import("../evals/fixtures/workflow-reliability/oracle.js");
  const attempts = Array.from({ length: 4 }, (_, index) => ({
    id: `a${index}`,
    state: "release",
    fingerprint: "same",
  }));
  expect(verifyWorkflowRetries(attempts).failures).toEqual([]);
  expect(
    verifyWorkflowRetries([
      ...attempts,
      { id: "other", state: "inspect", fingerprint: "different" },
      { id: "a4", state: "release", fingerprint: "same" },
    ]).failures,
  ).toContain("Recovery did not change release after four identical attempts");
  expect(
    verifyWorkflowRetries([...attempts, { id: "changed", state: "release", fingerprint: "new" }])
      .failures,
  ).toEqual([]);
});
