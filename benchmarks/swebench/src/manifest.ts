/** Programming languages named by the official SWE-bench Multilingual benchmark. */
export const LANGUAGES = [
  "C",
  "C++",
  "Go",
  "Java",
  "JavaScript",
  "TypeScript",
  "PHP",
  "Ruby",
  "Rust",
] as const;

export type Language = (typeof LANGUAGES)[number];

/** Dataset fields needed to identify and provision one official task image. */
export interface DatasetRow {
  repo: string;
  instanceId: string;
  baseCommit: string;
}

/** Reduced dataset snapshot paired with the immutable Hugging Face revision it came from. */
export interface DatasetSnapshot {
  datasetRevision: string;
  rows: DatasetRow[];
}

/** Stable task identity committed before any measured rollout starts. */
export interface ManifestEntry {
  instanceId: string;
  language: Language;
  repo: string;
  baseCommit: string;
}

/** Reproducible, language-stratified task set shared by every campaign arm. */
export interface InstanceManifest {
  datasetRevision: string;
  seed: number;
  algorithmVersion: typeof MANIFEST_ALGORITHM_VERSION;
  entries: ManifestEntry[];
}

/** Inputs that determine a manifest byte-for-byte. */
export interface SelectManifestOptions {
  /** Unsigned 32-bit seed consumed by the checked-in selection algorithm. */
  seed: number;
  /** Total instances; allocation across the nine language buckets differs by at most one. */
  size: number;
}

export const MANIFEST_ALGORITHM_VERSION = "language-stratified-v1";

/*
 * Pinned from SWE-bench harness revision f7bbbb2 (`constants/*.py`) and the
 * official repository table at https://www.swebench.com/multilingual.html.
 * The harness combines JavaScript and TypeScript; its seven repositories are
 * separated here by primary repository language so all nine benchmark
 * languages remain observable.
 */
export const REPO_LANGUAGE: Readonly<Record<string, Language>> = {
  "redis/redis": "C",
  "jqlang/jq": "C",
  "micropython/micropython": "C",
  "valkey-io/valkey": "C",
  "nlohmann/json": "C++",
  "fmtlib/fmt": "C++",
  "caddyserver/caddy": "Go",
  "hashicorp/terraform": "Go",
  "prometheus/prometheus": "Go",
  "gohugoio/hugo": "Go",
  "gin-gonic/gin": "Go",
  "google/gson": "Java",
  "apache/druid": "Java",
  "javaparser/javaparser": "Java",
  "projectlombok/lombok": "Java",
  "apache/lucene": "Java",
  "reactivex/rxjava": "Java",
  "mrdoob/three.js": "JavaScript",
  "preactjs/preact": "JavaScript",
  "axios/axios": "JavaScript",
  "babel/babel": "TypeScript",
  "vuejs/core": "TypeScript",
  "facebook/docusaurus": "TypeScript",
  "immutable-js/immutable-js": "TypeScript",
  "phpoffice/phpspreadsheet": "PHP",
  "laravel/framework": "PHP",
  "php-cs-fixer/php-cs-fixer": "PHP",
  "briannesbitt/carbon": "PHP",
  "jekyll/jekyll": "Ruby",
  "fluent/fluentd": "Ruby",
  "fastlane/fastlane": "Ruby",
  "jordansissel/fpm": "Ruby",
  "faker-ruby/faker": "Ruby",
  "rubocop/rubocop": "Ruby",
  "burntsushi/ripgrep": "Rust",
  "sharkdp/bat": "Rust",
  "astral-sh/ruff": "Rust",
  "tokio-rs/tokio": "Rust",
  "uutils/coreutils": "Rust",
  "nushell/nushell": "Rust",
  "tokio-rs/axum": "Rust",
};

function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

/** Select the fixed pairing contract from sorted ids with a stable seeded PRNG. */
export function selectManifest(
  snapshot: DatasetSnapshot,
  options: SelectManifestOptions,
): InstanceManifest {
  if (!snapshot.datasetRevision.trim()) throw new Error("Dataset revision must be recorded.");
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) {
    throw new Error("Manifest seed must be an unsigned 32-bit integer.");
  }
  if (!Number.isSafeInteger(options.size) || options.size < LANGUAGES.length) {
    throw new Error(`Manifest size must be an integer of at least ${LANGUAGES.length}.`);
  }

  const ids = new Set<string>();
  const buckets = new Map<Language, DatasetRow[]>(LANGUAGES.map((language) => [language, []]));
  for (const row of [...snapshot.rows].sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId),
  )) {
    if (ids.has(row.instanceId)) throw new Error(`Duplicate instance id: ${row.instanceId}.`);
    ids.add(row.instanceId);
    const language = REPO_LANGUAGE[row.repo];
    if (!language) throw new Error(`Unknown SWE-bench Multilingual repository: ${row.repo}.`);
    buckets.get(language)!.push(row);
  }
  if (options.size > snapshot.rows.length) {
    throw new Error(`Manifest size ${options.size} exceeds ${snapshot.rows.length} dataset rows.`);
  }

  const random = makePrng(options.seed);
  const extraLanguages = new Set(
    shuffle(LANGUAGES, random).slice(0, options.size % LANGUAGES.length),
  );
  const baseCount = Math.floor(options.size / LANGUAGES.length);
  const selected: ManifestEntry[] = [];

  for (const language of LANGUAGES) {
    const count = baseCount + (extraLanguages.has(language) ? 1 : 0);
    const bucket = buckets.get(language)!;
    if (bucket.length < count) {
      throw new Error(
        `Language ${language} has only ${bucket.length} rows; ${count} are required.`,
      );
    }
    selected.push(
      ...shuffle(bucket, random)
        .slice(0, count)
        .map((row) => ({
          instanceId: row.instanceId,
          language,
          repo: row.repo,
          baseCommit: row.baseCommit,
        })),
    );
  }

  selected.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  return {
    datasetRevision: snapshot.datasetRevision,
    seed: options.seed,
    algorithmVersion: MANIFEST_ALGORITHM_VERSION,
    entries: selected,
  };
}

/** Canonical on-disk representation used for reproducibility and hashing. */
export function serializeManifest(manifest: InstanceManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
