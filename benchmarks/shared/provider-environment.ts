import { SUPPORTED_API_KEYS } from "../../src/cli/shared.js";

/** Product-owned provider credential names used by benchmark workers. */
export const PROVIDER_ENV_NAMES = SUPPORTED_API_KEYS;

/** Select only model-gateway credentials; sandbox control keys stay on the host. */
export function providerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of PROVIDER_ENV_NAMES) {
    const value = source[name];
    if (value) result[name] = value;
  }
  if (Object.keys(result).length === 0) {
    throw new Error("No supported model gateway key is available for benchmark workers.");
  }
  return result;
}
