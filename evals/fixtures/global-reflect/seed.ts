import type { MemoryFixture } from "../../../test/helpers/memory-fixture.js";
import type { SeedObservation } from "./sandbox-memories.js";

/**
 * Seed a memory fixture with the given observations and back-date
 * their `created_at` / `last_used_at` to match `ageDays`. The global
 * reflect pipeline gates eligibility on `created_at <= now - minAgeMs`,
 * so accurate ageDays values are load-bearing for evals that exercise
 * the min-age gate — set them explicitly per-fixture when the eval
 * cares about partitioning.
 */
export async function seedObservations(
  fixture: MemoryFixture,
  seeds: SeedObservation[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const seed of seeds) {
    const observation = await fixture.append({
      sessionId: seed.sessionId ?? "session_seed",
      kind: seed.kind,
      observedDate: seed.observedDate,
      priority: seed.priority,
      source: seed.source,
      content: seed.content,
      tags: seed.tags,
      ...(seed.timeOfDay !== undefined ? { timeOfDay: seed.timeOfDay } : {}),
      ...(seed.referencedDate !== undefined ? { referencedDate: seed.referencedDate } : {}),
      ...(seed.relativeDate !== undefined ? { relativeDate: seed.relativeDate } : {}),
    });
    ids.push(observation.id);
    const target = Date.now() - seed.ageDays * 24 * 60 * 60 * 1000;
    await fixture.session.withDb(async (db) => {
      await db.query("UPDATE observations SET created_at = $1, last_used_at = $1 WHERE id = $2", [
        target,
        observation.id,
      ]);
    });
  }
  return ids;
}
