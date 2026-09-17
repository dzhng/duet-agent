/** POSIX shell quoting for immutable paths and task ids sent to E2B workers. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Template identity includes the exact Duet commit under evaluation. */
export function deepSweTemplateName(repositorySha: string): string {
  if (!/^[0-9a-f]{40}$/.test(repositorySha)) {
    throw new Error(`Invalid repository SHA: ${repositorySha}`);
  }
  return `duet-deepswe-${repositorySha.slice(0, 12)}`;
}
