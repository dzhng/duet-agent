import { createHash } from "node:crypto";

/** Facts collected by the harness, outside the repository the agent edits. */
export interface UnchangedFile {
  path: string;
  before: string;
  after: string | null;
}

export interface SearchProbe {
  category: "people" | "jobs";
  query: string;
  /** Generated after agent work, and echoed by the controlled provider. */
  nonce: string;
  expectedIds: string[];
}

export interface SearchResponse {
  nonce: string;
  status: number;
  body: unknown;
}

export interface ProviderCall {
  category: string;
  query: string;
  nonce: string;
  status: number;
  ids: string[];
}

export interface OutcomeVerdict {
  /** Empty only when every independently observed behavior agrees. */
  failures: string[];
}

function unchangedFailures(files: UnchangedFile[]): string[] {
  return files
    .filter((file) => file.before !== file.after)
    .map((file) => `Out-of-scope file changed: ${file.path}`);
}

function sameIds(actual: unknown, expected: string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.every((id) => typeof id === "string") &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

export function verifySearchOutcome(input: {
  probes: SearchProbe[];
  responses: SearchResponse[];
  providerCalls: ProviderCall[];
  unchangedFiles: UnchangedFile[];
}): OutcomeVerdict {
  const failures = unchangedFailures(input.unchangedFiles);
  if (input.probes.length === 0) failures.push("Search proof has no probes");
  for (const probe of input.probes) {
    const response = input.responses.find((response) => response.nonce === probe.nonce);
    const body = response?.body;
    if (
      response?.status !== 200 ||
      !body ||
      typeof body !== "object" ||
      !("ids" in body) ||
      !sameIds(body.ids, probe.expectedIds) ||
      !("nonce" in body) ||
      body.nonce !== probe.nonce
    ) {
      failures.push(`Incorrect search response for ${probe.nonce}`);
    }
    if (
      !input.providerCalls.some(
        (call) =>
          call.nonce === probe.nonce &&
          call.category === probe.category &&
          call.query === probe.query &&
          call.status === 200 &&
          sameIds(call.ids, probe.expectedIds),
      )
    ) {
      failures.push(`No successful provider call for ${probe.nonce}`);
    }
  }
  return { failures };
}

export function verifyReleaseOutcome(input: {
  recordedSha: string;
  /** Resolve with Git, never from an agent-written receipt alone. */
  commitSha: string | null;
  committedSource: string | null;
  releasedSource: string | null;
  /** Run independent behavioral queries against the released implementation. */
  behaviorFailures: string[];
  /** Observed in the actual post-resume relay definition. */
  correctionPersisted: boolean;
  unchangedFiles: UnchangedFile[];
}): OutcomeVerdict {
  const failures = [...unchangedFailures(input.unchangedFiles), ...input.behaviorFailures];
  if (!/^[a-f0-9]{40}$/.test(input.recordedSha) || input.recordedSha !== input.commitSha) {
    failures.push("Recorded commit does not exist or differs from release SHA");
  }
  if (
    input.committedSource === null ||
    input.releasedSource === null ||
    input.committedSource !== input.releasedSource
  ) {
    failures.push("Released source differs from committed source");
  }
  if (!input.correctionPersisted)
    failures.push("User correction did not survive in the relay definition");
  return { failures };
}

export interface WorkflowArchive {
  revision: number;
  limits: { wallClockMs: number; toolCalls: number };
  unchangedPaths: string[];
  files: Record<string, string>;
  scenarios: Array<{ id: string; prompt: string; correction?: string }>;
}

/** Verify the published bytes before seeding any agent-editable repository. */
export function readWorkflowArchive(text: string, manifest: { sha256: string }): WorkflowArchive {
  if (createHash("sha256").update(text).digest("hex") !== manifest.sha256) {
    throw new Error("Workflow fixture archive SHA256 mismatch");
  }
  return JSON.parse(text) as WorkflowArchive;
}

/** Fresh nonces prevent an implementation from replaying an earlier successful reply. */
export function workflowSearchProbes(): SearchProbe[] {
  return [
    { category: "people", query: "engineers in Berlin", expectedIds: ["person-ada"] },
    { category: "jobs", query: "remote engineering jobs", expectedIds: ["job-platform"] },
    { category: "people", query: "ada@orbit.example", expectedIds: ["person-ada"] },
    { category: "people", query: "volcanologists on Neptune", expectedIds: [] },
    { category: "jobs", query: "volcanologists on Neptune", expectedIds: [] },
  ].map((probe) => ({
    ...probe,
    category: probe.category as SearchProbe["category"],
    nonce: crypto.randomUUID(),
  }));
}

/** Controlled external dependency; host this in the harness, not the task repository. */
export function createWorkflowProvider(unavailable = false): {
  calls: ProviderCall[];
  fetch: (request: Request) => Promise<Response>;
} {
  const calls: ProviderCall[] = [];
  return {
    calls,
    async fetch(request) {
      if (request.method !== "POST")
        return Response.json({ error: "Use POST JSON" }, { status: 405 });
      let value: unknown;
      try {
        value = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("category" in value) ||
        (value.category !== "people" && value.category !== "jobs") ||
        !("query" in value) ||
        typeof value.query !== "string" ||
        !("nonce" in value) ||
        typeof value.nonce !== "string"
      ) {
        return Response.json({ error: "Expected category, query, and nonce" }, { status: 400 });
      }
      const input = { category: value.category, query: value.query, nonce: value.nonce };
      const query = input.query.toLowerCase();
      const ids =
        input.category === "people"
          ? query.includes("ada") ||
            query.includes("orbit") ||
            (query.includes("engineer") && query.includes("berlin"))
            ? ["person-ada"]
            : []
          : query.includes("engineer") || query.includes("orbit")
            ? ["job-platform"]
            : [];
      const status = unavailable ? 503 : 200;
      calls.push({ ...input, status, ids: unavailable ? [] : ids });
      return Response.json(
        unavailable ? { error: "Synthetic provider unavailable" } : { ids, nonce: input.nonce },
        { status },
      );
    },
  };
}

/** Seed a bad release dependency, not a pre-solved transition. The model must repair it. */
export function workflowReleaseDefinition(
  prompt: string,
): import("../../../src/types/state-machine.js").StateMachineDefinition {
  return {
    name: "Directory release",
    prompt: `${prompt}\nRun release first. If the worker reports CANDIDATE_SHA_REQUIRED, park in awaiting_correction until the user resolves the prerequisite. After a user says to persist the correction and park, update the release definition and park without executing it. When the user later says continue, execute release with the corrected instructions, then select done. Status questions only need an answer.`,
    states: [
      {
        name: "release",
        kind: "agent",
        prompt: `${prompt}\nBefore creating any commit, require release/candidate-sha.txt to contain an existing candidate commit SHA. If absent, do not commit; report CANDIDATE_SHA_REQUIRED.`,
      },
      {
        name: "awaiting_correction",
        kind: "park",
        when: "Wait for the user to correct the circular prerequisite or continue.",
      },
      { name: "done", kind: "terminal", status: "completed" },
    ],
  };
}

/** Outcome bound for these finite fixtures, not a product ban on repeated work. */
export function verifyWorkflowRetries(
  attempts: Array<{ id: string; state: string; fingerprint: string }>,
): OutcomeVerdict {
  const seen = new Set<string>();
  const latest = new Map<string, { fingerprint: string; count: number }>();
  const failures: string[] = [];
  for (const attempt of attempts) {
    if (seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    const previous = latest.get(attempt.state);
    const count = previous?.fingerprint === attempt.fingerprint ? previous.count + 1 : 1;
    latest.set(attempt.state, { fingerprint: attempt.fingerprint, count });
    if (count === 5)
      failures.push(`Recovery did not change ${attempt.state} after four identical attempts`);
  }
  return { failures };
}

/** An outage claim is judged against the observed blocker, not later feature completion. */
export function verifyIncompleteOutcome(input: {
  providerCalls: ProviderCall[];
  unchangedFiles: UnchangedFile[];
  reportAssessment: { valid: boolean; reason: string };
}): OutcomeVerdict {
  const failures = unchangedFailures(input.unchangedFiles);
  if (!input.providerCalls.some((call) => call.status === 503))
    failures.push("No provider outage observed");
  if (!input.reportAssessment.valid) failures.push(input.reportAssessment.reason);
  return { failures };
}
