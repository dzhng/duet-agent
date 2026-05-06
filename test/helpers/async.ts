import { setTimeout as delay } from "node:timers/promises";

export { delay };

export async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await delay(1);
  }
}
