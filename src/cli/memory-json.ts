import type {
  Observation,
  ObservationKind,
  ObservationPriority,
  ObservationSource,
} from "../types/memory.js";

/**
 * Canonical JSON shape for a single memory row, shared by every command that
 * emits an observation (`memory recall`, `memory` query, `memory add`). Kept
 * in one place — see {@link toMemoryJson} — so consumers parse one type
 * everywhere instead of one shape per command.
 *
 * Deviations from the in-memory {@link Observation}:
 *   - `createdAt`/`lastUsedAt` are ISO 8601 strings, not millisecond epochs,
 *     so wire consumers never have to guess the unit.
 *   - `source` is flattened to its `kind` string; the structured
 *     `{ kind, name? }` union is a runtime-only detail.
 *   - The two ranking scores are named explicitly (`packScore`,
 *     `relevanceScore`); there is deliberately no generic `score` field.
 */
export interface MemoryJson {
  /** Stable persistence key for the row. */
  id: string;
  /** The memory text. */
  content: string;
  /** Raw observation, reflection, single user note, or bulk-curated manual row. */
  kind: ObservationKind;
  /** Flattened source origin — the `kind` of the structured {@link ObservationSource}. */
  source: ObservationSource["kind"];
  /** Importance signal used by recall and context ranking. */
  priority: ObservationPriority;
  /** When the row was stored, as an ISO 8601 timestamp. */
  createdAt: string;
  /** Most recent turn that used the row, as an ISO 8601 timestamp. */
  lastUsedAt: string;
  /** Calendar date the observation is anchored to. */
  observedDate: string;
  /** Concrete date mentioned by the user/tool when different from `observedDate`. */
  referencedDate?: string;
  /** Original relative date phrase ("tomorrow", "last week") when useful. */
  relativeDate?: string;
  /** 24-hour local time attached to the observation, when available. */
  timeOfDay?: string;
  /**
   * Session that authored the row. Absent on legacy/global rows that predate
   * session tracking; echoed only when the observation actually carries one.
   */
  sessionId?: string;
  /** Lightweight filtering/grouping labels. */
  tags: string[];
  /**
   * Global-pack ranking score (recency × priority × kind bias). Included only
   * when the caller computed a pack score for this row.
   */
  packScore?: number;
  /**
   * Query-relevance score (RRF-fused across phrasings). Included only in
   * `memory recall` output; absent — never null — everywhere else.
   */
  relevanceScore?: number;
}

/**
 * Serialize an {@link Observation} into the canonical {@link MemoryJson}
 * shape. Optional ranking scores are attached only when provided, matching
 * the contract that both scores are named explicitly and omitted rather than
 * emitted as null.
 */
export function toMemoryJson(
  observation: Observation,
  opts: { packScore?: number; relevanceScore?: number } = {},
): MemoryJson {
  return {
    id: observation.id,
    content: observation.content,
    kind: observation.kind,
    source: observation.source.kind,
    priority: observation.priority,
    createdAt: new Date(observation.createdAt).toISOString(),
    lastUsedAt: new Date(observation.lastUsedAt).toISOString(),
    observedDate: observation.observedDate,
    ...(observation.referencedDate !== undefined
      ? { referencedDate: observation.referencedDate }
      : {}),
    ...(observation.relativeDate !== undefined ? { relativeDate: observation.relativeDate } : {}),
    ...(observation.timeOfDay !== undefined ? { timeOfDay: observation.timeOfDay } : {}),
    ...(observation.sessionId !== undefined ? { sessionId: observation.sessionId } : {}),
    tags: observation.tags,
    ...(opts.packScore !== undefined ? { packScore: opts.packScore } : {}),
    ...(opts.relevanceScore !== undefined ? { relevanceScore: opts.relevanceScore } : {}),
  };
}
