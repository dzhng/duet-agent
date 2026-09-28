export async function interpret(
  category: string,
  query: string,
  nonce: string,
): Promise<{ ids: string[]; nonce: string }> {
  // The demo provider is still wired in. The real endpoint is in provider.json.
  return { ids: category === "jobs" && query === "demo" ? ["job-platform"] : [], nonce };
}
