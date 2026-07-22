import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { acquireFileLock, releaseFileLock } from "../file-lock.js";

export type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

export type ConnectedProviderId = "openai-codex" | "github-copilot";
export type ConnectionEligibility = "unknown" | "eligible" | "plan_ineligible";

export interface ConnectionRecord {
  /** Transport whose subscription these credentials authorize. */
  provider: ConnectedProviderId;
  /** Complete pi-ai OAuth token set; refresh replaces this object wholesale. */
  credentials: OAuthCredentials;
  /** Epoch milliseconds when the user completed the connection flow. */
  connectedAt: number;
  /** Whether the linked subscription passed the provider capability probe. */
  eligibility: ConnectionEligibility;
  /** Epoch milliseconds of the latest capability probe, when one has run. */
  eligibilityCheckedAt?: number;
  /** Epoch milliseconds of the latest successful credential refresh. */
  lastRefreshAt?: number;
}

export interface ConnectedProviderStore {
  /** Read every valid record without taking the writer lock. */
  read(): Promise<ConnectionRecord[]>;
  /** Read one provider's current record without taking the writer lock. */
  get(id: ConnectedProviderId): Promise<ConnectionRecord | undefined>;
  /** Delete one provider while preserving every other valid record. */
  remove(id: ConnectedProviderId): Promise<void>;
  /** Locked read-modify-write; mutate receives the current on-disk record. */
  withLock<T>(
    id: ConnectedProviderId,
    mutate: (
      current: ConnectionRecord | undefined,
    ) => Promise<{ next?: ConnectionRecord; result: T }>,
  ): Promise<T>;
}

export const CONNECTED_PROVIDERS_FILE = "connected-providers.json";

const STORE_VERSION = 1;
const PROVIDER_ORDER: readonly ConnectedProviderId[] = ["openai-codex", "github-copilot"];
const LOCK_RETRY_MS = 20;

interface StoreDocument {
  version: typeof STORE_VERSION;
  connections: Partial<Record<ConnectedProviderId, ConnectionRecord>>;
}

export function createConnectedProviderStore(
  opts: { homeDir?: string; now?: () => number } = {},
): ConnectedProviderStore {
  const duetDir = join(opts.homeDir ?? homedir(), ".duet");
  const storePath = join(duetDir, CONNECTED_PROVIDERS_FILE);
  const lockPath = join(duetDir, `${CONNECTED_PROVIDERS_FILE}.lock`);
  const now = opts.now ?? (() => Date.now());

  const readDocument = async (): Promise<StoreDocument> => {
    let raw: string;
    try {
      raw = await readFile(storePath, "utf8");
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return emptyDocument();
      warnUnreadable(storePath);
      return emptyDocument();
    }

    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.connections)) {
        warnUnreadable(storePath);
        return emptyDocument();
      }
      const connections: StoreDocument["connections"] = {};
      for (const provider of PROVIDER_ORDER) {
        const candidate = value.connections[provider];
        if (candidate === undefined) continue;
        if (isConnectionRecord(candidate, provider)) connections[provider] = candidate;
        else console.warn(`Ignoring invalid ${provider} record in ${storePath}.`);
      }
      return { version: STORE_VERSION, connections };
    } catch {
      warnUnreadable(storePath);
      return emptyDocument();
    }
  };

  const writeDocument = async (document: StoreDocument): Promise<void> => {
    await mkdir(duetDir, { recursive: true, mode: 0o700 });
    await chmod(duetDir, 0o700);
    const tempPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, storePath);
      await chmod(storePath, 0o600);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  };

  const withLock: ConnectedProviderStore["withLock"] = async <T>(
    id: ConnectedProviderId,
    mutate: (
      current: ConnectionRecord | undefined,
    ) => Promise<{ next?: ConnectionRecord; result: T }>,
  ): Promise<T> => {
    await mkdir(duetDir, { recursive: true, mode: 0o700 });
    await chmod(duetDir, 0o700);
    let handle = acquireFileLock(lockPath, { now: now() });
    while (handle === null) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      handle = acquireFileLock(lockPath, { now: now() });
    }

    try {
      const document = await readDocument();
      const { next, result } = await mutate(document.connections[id]);
      if (next === undefined) delete document.connections[id];
      else {
        if (!isConnectionRecord(next, id)) {
          throw new Error(`Connection record must match lock provider ${id}`);
        }
        document.connections[id] = next;
      }
      await writeDocument(document);
      return result;
    } finally {
      releaseFileLock(handle);
    }
  };

  return {
    async read() {
      const document = await readDocument();
      return PROVIDER_ORDER.flatMap((provider) => {
        const connection = document.connections[provider];
        return connection ? [connection] : [];
      });
    },
    async get(id) {
      return (await readDocument()).connections[id];
    },
    async remove(id) {
      await withLock(id, async () => ({ result: undefined }));
    },
    withLock,
  };
}

function emptyDocument(): StoreDocument {
  return { version: STORE_VERSION, connections: {} };
}

function warnUnreadable(path: string): void {
  console.warn(`Ignoring corrupt or unsupported connected-provider store at ${path}.`);
}

function isConnectionRecord(
  value: unknown,
  provider: ConnectedProviderId,
): value is ConnectionRecord {
  if (!isRecord(value) || value.provider !== provider || !isRecord(value.credentials)) return false;
  const credentials = value.credentials;
  return (
    typeof credentials.access === "string" &&
    typeof credentials.refresh === "string" &&
    typeof credentials.expires === "number" &&
    typeof value.connectedAt === "number" &&
    isEligibility(value.eligibility) &&
    isOptionalNumber(value.eligibilityCheckedAt) &&
    isOptionalNumber(value.lastRefreshAt)
  );
}

function isEligibility(value: unknown): value is ConnectionEligibility {
  return value === "unknown" || value === "eligible" || value === "plan_ineligible";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
