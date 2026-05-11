// Best-effort npm registry probe. Failures (offline, slow, registry hiccup)
// intentionally turn into noop: the CLI must remain usable when the registry
// is unreachable. Callers pass their own timeout because the right value
// depends on whether the user is actively waiting (foreground `duet upgrade`)
// or the work is happening behind a TUI placeholder.
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 1_500;

/**
 * Compare two semver-ish strings. Returns -1, 0, or 1 like Array.sort.
 *
 * Pre-release ordering follows the simple rule "release wins over pre-release",
 * which is enough for the upgrade-notice path; full SemVer 2.0 ordering is
 * not required here because we only compare published npm versions.
 */
export function compareSemverVersions(left: string, right: string): number {
  const leftParts = parseSemverVersion(left);
  const rightParts = parseSemverVersion(right);
  for (let i = 0; i < 3; i++) {
    const delta = leftParts.numbers[i]! - rightParts.numbers[i]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (leftParts.prerelease === rightParts.prerelease) return 0;
  if (!leftParts.prerelease) return 1;
  if (!rightParts.prerelease) return -1;
  return leftParts.prerelease.localeCompare(rightParts.prerelease);
}

function parseSemverVersion(version: string): {
  numbers: [number, number, number];
  prerelease?: string;
} {
  const [main = "", prerelease] = version.replace(/^v/, "").split("-", 2);
  const [major = "0", minor = "0", patch = "0"] = main.split(".");
  return {
    numbers: [Number(major) || 0, Number(minor) || 0, Number(patch) || 0],
    ...(prerelease ? { prerelease } : {}),
  };
}

/**
 * Fetch the `latest` dist-tag for a package from the npm registry.
 * Returns undefined on any failure so callers can no-op silently.
 */
export async function fetchLatestPackageVersion(
  packageName: string,
  timeoutMs: number = DEFAULT_VERSION_CHECK_TIMEOUT_MS,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const metadataUrl = `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`;
    const response = await fetch(metadataUrl, { signal: controller.signal });
    if (!response.ok) return undefined;
    const metadata = (await response.json()) as {
      "dist-tags"?: { latest?: unknown };
    };
    const latest = metadata["dist-tags"]?.latest;
    return typeof latest === "string" ? latest : undefined;
  } finally {
    clearTimeout(timeout);
  }
}
