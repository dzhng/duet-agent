/**
 * The tag scheme every `duet train` row carries, owned in one place so the
 * create/replace path and the list/show/update/delete commands agree on it.
 *
 * Each trained observation is tagged with both `TRAIN_TAG` (marks the row as
 * train-managed) and `trainSlugTag(slug)` (the per-corpus identity). The slug
 * is the stable, user-facing handle: the CRUD commands resolve a slug to its
 * row via these helpers rather than exposing the internal `mem_…` id.
 */
export const TRAIN_TAG = "train";

const TRAIN_SLUG_PREFIX = "train:";

/** The per-corpus identity tag, e.g. `train:acme-research`. */
export function trainSlugTag(slug: string): string {
  return `${TRAIN_SLUG_PREFIX}${slug}`;
}

/** True when the observation is a `duet train` row. */
export function isTrainTagged(tags: readonly string[]): boolean {
  return tags.includes(TRAIN_TAG);
}

/** Extract the slug from a train row's tags, or `undefined` if none is present. */
export function slugFromTags(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith(TRAIN_SLUG_PREFIX))?.slice(TRAIN_SLUG_PREFIX.length);
}
