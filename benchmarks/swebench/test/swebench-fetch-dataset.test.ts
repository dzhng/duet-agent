import { describe, expect, test } from "bun:test";

import { fetchDataset } from "../src/fetch-dataset.js";

const REVISION = "revision";

describe("SWE-bench dataset fetch", () => {
  test("retries a transient page without duplicating its rows", async () => {
    let calls = 0;
    const delays: number[] = [];
    const snapshot = await fetchDataset({
      expectedRevision: REVISION,
      retryDelaysMs: [7],
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return new Response("temporary", { status: 502 });
        return datasetResponse();
      }) as typeof fetch,
    });

    expect(calls).toBe(2);
    expect(delays).toEqual([7]);
    expect(snapshot).toEqual({
      datasetRevision: REVISION,
      rows: [
        {
          repo: "org/repo",
          instanceId: "org__repo-1",
          baseCommit: "commit",
          problemStatement: "Fix it",
        },
      ],
    });
  });

  test("does not retry a permanent client failure", async () => {
    let calls = 0;
    await expect(
      fetchDataset({
        expectedRevision: REVISION,
        retryDelaysMs: [0, 0],
        sleep: async () => undefined,
        fetchImpl: (async () => {
          calls += 1;
          return new Response("bad request", { status: 400 });
        }) as typeof fetch,
      }),
    ).rejects.toThrow("Dataset request failed (400) for offset 0");
    expect(calls).toBe(1);
  });

  test("retries a transient transport failure", async () => {
    let calls = 0;
    const snapshot = await fetchDataset({
      expectedRevision: REVISION,
      retryDelaysMs: [0],
      sleep: async () => undefined,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("connection reset");
        return datasetResponse();
      }) as typeof fetch,
    });

    expect(calls).toBe(2);
    expect(snapshot.rows[0]?.instanceId).toBe("org__repo-1");
  });
});

function datasetResponse(): Response {
  return Response.json(
    {
      num_rows_total: 1,
      rows: [
        {
          row: {
            repo: "org/repo",
            instance_id: "org__repo-1",
            base_commit: "commit",
            problem_statement: "Fix it",
          },
        },
      ],
    },
    { headers: { "x-revision": REVISION } },
  );
}
