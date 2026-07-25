import { DEEPSWE_ARMS } from "./config.js";

/** Pier ceiling for one Duet agent invocation. */
export const DEEPSWE_AGENT_TIMEOUT_SEC = 5_400;
/** Driver stop requested before Pier's outer agent timeout. */
export const DEEPSWE_AGENT_WALL_CLOCK_MS = 5_300_000;
/** Official pilot tasks give their separate verifier up to 30 minutes. */
export const DEEPSWE_VERIFIER_TIMEOUT_SEC = 1_800;
/** Official task and separate-verifier environment build ceilings. */
export const DEEPSWE_ENVIRONMENT_BUILD_TIMEOUT_SEC = 1_800;
export const DEEPSWE_VERIFIER_ENVIRONMENT_BUILD_TIMEOUT_SEC = 1_800;
/** Agent setup, artifact collection, and commit allowance per trial. */
const DEEPSWE_TRIAL_OVERHEAD_MS = 15 * 60_000;
/** All configured arms run sequentially within one task sandbox. */
export const DEEPSWE_WORKER_COMMAND_TIMEOUT_MS =
  Object.keys(DEEPSWE_ARMS).length *
  ((DEEPSWE_AGENT_TIMEOUT_SEC +
    DEEPSWE_VERIFIER_TIMEOUT_SEC +
    DEEPSWE_ENVIRONMENT_BUILD_TIMEOUT_SEC +
    DEEPSWE_VERIFIER_ENVIRONMENT_BUILD_TIMEOUT_SEC) *
    1_000 +
    DEEPSWE_TRIAL_OVERHEAD_MS);
/** E2B lifetime includes controller-side archive transfer and teardown headroom. */
export const DEEPSWE_WORKER_TIMEOUT_MS = DEEPSWE_WORKER_COMMAND_TIMEOUT_MS + 10 * 60_000;
