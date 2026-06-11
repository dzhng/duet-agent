import path from "node:path";

/** The four real-data train corpora, shared across rubric generation,
 *  the comparative eval, and the sweep runner so they never drift. */
export interface CorpusDef {
  slug: string;
  corpus: string;
}

export const CORPORA: CorpusDef[] = [
  { slug: "vercel-eval", corpus: "train-corpus-vercel" },
  { slug: "stripe-eval", corpus: "train-corpus-stripe" },
  { slug: "htmx-eval", corpus: "train-corpus-htmx" },
  { slug: "snowflake-eval", corpus: "train-corpus-snowflake" },
];

export const FIXTURES_DIR = path.join(import.meta.dir, "..", "fixtures");
export const RUBRICS_DIR = path.join(import.meta.dir, "..", "rubrics");

export function fixtureDirFor(c: CorpusDef): string {
  return path.join(FIXTURES_DIR, c.corpus);
}

export function rubricPathFor(c: CorpusDef): string {
  return path.join(RUBRICS_DIR, `${c.slug}.json`);
}
