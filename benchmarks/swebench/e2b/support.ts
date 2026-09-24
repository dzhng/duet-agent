import type { PGliteRuntimeAssetName } from "../../../src/memory/pglite.js";

const GIT_SHA = /^[0-9a-f]{40}$/i;

/** Stable E2B template name tied to every committed benchmark input. */
export function e2bTemplateName(repositorySha: string): string {
  if (!GIT_SHA.test(repositorySha)) throw new Error("E2B template requires a full git SHA.");
  return `duet-swebench-${repositorySha.slice(0, 12).toLowerCase()}`;
}

export interface E2BEnvironmentProbe {
  /** Immutable E2B template name derived from the repository SHA. */
  templateName: string;
  /** Provider-assigned identity of the built template. */
  templateId: string;
  /** Resources visible to each worker sandbox. */
  cpuCount: number;
  memoryMb: number;
  /** Exact committed source embedded in the template. */
  repositorySha: string;
  architecture: string;
  osRelease: string;
  dockerClientVersion: string;
  dockerServerVersion: string;
  /** SHA-256 of the one Duet binary embedded in the worker template. */
  duetArtifactSha256: string;
  /** SHA-256 of every PGlite sidecar beside the compiled binary. */
  runtimeAssetSha256: Record<PGliteRuntimeAssetName, string>;
  pythonVersion: string;
  swebenchVersion: string;
}

/** Stable provenance shared byte-for-byte by every sandbox in one campaign. */
export function buildE2BEnvironmentLock(probe: E2BEnvironmentProbe): object {
  return {
    schemaVersion: 1,
    backend: "e2b",
    template: {
      name: probe.templateName,
      id: probe.templateId,
      repositorySha: probe.repositorySha,
    },
    worker: {
      architecture: probe.architecture,
      cpuCount: probe.cpuCount,
      memoryMb: probe.memoryMb,
      osRelease: probe.osRelease,
    },
    docker: {
      clientVersion: probe.dockerClientVersion,
      serverVersion: probe.dockerServerVersion,
    },
    duetArtifact: {
      sha256: probe.duetArtifactSha256,
      runtimeAssetSha256: probe.runtimeAssetSha256,
    },
    python: {
      version: probe.pythonVersion,
      swebenchVersion: probe.swebenchVersion,
    },
  };
}

/** Quote one trusted scalar for a remote POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
