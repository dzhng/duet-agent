// Best-effort npm registry probe used to surface "duet upgrade" reminders.
// Failures (offline, slow, registry hiccup) intentionally turn into noop:
// the CLI must remain usable when the registry is unreachable.

const VERSION_CHECK_TIMEOUT_MS = 1_500;

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
export async function fetchLatestPackageVersion(packageName: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
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

/** Format the "Update available" notice we print at startup. */
export function formatNewVersionNotice(
  packageName: string,
  currentVersion: string,
  latestVersion: string,
): string {
  return `Update available: ${packageName} ${currentVersion} -> ${latestVersion}. Run: duet upgrade`;
}

/**
 * Resolve the upgrade notice for `packageName@currentVersion`. Returns
 * undefined when the user is already on the latest version or the registry
 * lookup failed; callers print whatever string comes back.
 */
export async function getNewVersionNotice(
  packageName: string,
  currentVersion: string,
): Promise<string | undefined> {
  try {
    const latestVersion = await fetchLatestPackageVersion(packageName);
    if (!latestVersion) return undefined;
    if (compareSemverVersions(latestVersion, currentVersion) <= 0) return undefined;
    return formatNewVersionNotice(packageName, currentVersion, latestVersion);
  } catch {
    return undefined;
  }
}
