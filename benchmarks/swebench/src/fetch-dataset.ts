import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DatasetRow, DatasetSnapshot } from "./manifest.js";

export const DATASET_ID = "SWE-bench/SWE-bench_Multilingual";
export const DATASET_CONFIG = "default";
export const DATASET_SPLIT = "test";
export const PINNED_DATASET_REVISION = "2b7aced941b4873e9cad3e76abbae93f481d1beb";

const DATASETS_SERVER_ROWS_URL = "https://datasets-server.huggingface.co/rows";
const PAGE_SIZE = 100;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

interface DatasetServerRow {
  row: {
    repo: unknown;
    instance_id: unknown;
    base_commit: unknown;
    problem_statement: unknown;
  };
}

interface DatasetServerPage {
  rows: DatasetServerRow[];
  num_rows_total: number;
}

/** Options for downloading the exact dataset snapshot used by a campaign manifest. */
export interface FetchDatasetOptions {
  /** Refuse data whose datasets-server revision differs from this immutable commit. */
  expectedRevision?: string;
  /** Injectable HTTP boundary used by fixture tests. */
  fetchImpl?: typeof fetch;
  /** Delays between retries for rate limits and transient server failures. */
  retryDelaysMs?: readonly number[];
  /** Injectable timer used to test retries without wall-clock delays. */
  sleep?: (milliseconds: number) => Promise<void>;
}

function parseRow(value: DatasetServerRow, index: number): DatasetRow {
  const {
    repo,
    instance_id: instanceId,
    base_commit: baseCommit,
    problem_statement: problemStatement,
  } = value.row;
  if (
    typeof repo !== "string" ||
    typeof instanceId !== "string" ||
    typeof baseCommit !== "string" ||
    typeof problemStatement !== "string"
  ) {
    throw new Error(
      `Dataset row ${index} is missing repo, instance_id, base_commit, or problem_statement.`,
    );
  }
  return { repo, instanceId, baseCommit, problemStatement };
}

/** Download all rows while proving every page came from one pinned dataset revision. */
export async function fetchDataset(options: FetchDatasetOptions = {}): Promise<DatasetSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const expectedRevision = options.expectedRevision ?? PINNED_DATASET_REVISION;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const rows: DatasetRow[] = [];
  let total = Number.POSITIVE_INFINITY;

  while (rows.length < total) {
    const offset = rows.length;
    const url = new URL(DATASETS_SERVER_ROWS_URL);
    url.searchParams.set("dataset", DATASET_ID);
    url.searchParams.set("config", DATASET_CONFIG);
    url.searchParams.set("split", DATASET_SPLIT);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(PAGE_SIZE));

    const response = await fetchPage(fetchImpl, url, offset, retryDelaysMs, sleep);
    if (!response.ok) {
      throw new Error(`Dataset request failed (${response.status}) for offset ${offset}.`);
    }
    const revision = response.headers.get("x-revision");
    if (revision !== expectedRevision) {
      throw new Error(
        `Dataset revision mismatch: expected ${expectedRevision}, received ${revision ?? "none"}.`,
      );
    }

    const page = (await response.json()) as DatasetServerPage;
    if (!Number.isInteger(page.num_rows_total) || !Array.isArray(page.rows)) {
      throw new Error(`Dataset response for offset ${offset} has an invalid shape.`);
    }
    total = page.num_rows_total;
    rows.push(...page.rows.map((row, index) => parseRow(row, offset + index)));
    if (page.rows.length === 0 && rows.length < total) {
      throw new Error(`Dataset response ended at ${rows.length} of ${total} rows.`);
    }
  }

  if (rows.length !== total) {
    throw new Error(`Dataset returned ${rows.length} rows but declared ${total}.`);
  }
  return { datasetRevision: expectedRevision, rows };
}

async function fetchPage(
  fetchImpl: typeof fetch,
  url: URL,
  offset: number,
  retryDelaysMs: readonly number[],
  sleep: (milliseconds: number) => Promise<void>,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const delay = retryDelaysMs[attempt];
    try {
      const response = await fetchImpl(url);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || delay === undefined) return response;
    } catch (error) {
      if (delay === undefined) throw error;
    }
    await sleep(delay);
  }
}

/** Persist the non-gold dataset fields used to regenerate prompts and the manifest offline. */
export async function writeDatasetCache(path: string, snapshot: DatasetSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}
