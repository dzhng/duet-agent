export interface ArchivedFile {
  /** Path relative to the corpus folder root, posix separators. */
  relPath: string;
  /** Absolute on-disk path; used to copy files into the archive. */
  absPath: string;
  /** Raw byte size on disk, copied into the manifest for provenance. */
  bytes: number;
  /** SHA-256 of file bytes; lets a future re-train detect unchanged sources. */
  sha256: string;
}

export interface SynthesisResult {
  /** Short title (<120 chars) surfaced in the report block. Not persisted standalone. */
  headline: string;
  /** Durable memory text inserted as one high-priority observation. */
  observationContent: string;
}

/**
 * One training as surfaced by `duet train list` / `show`. The DB row is the
 * source of truth for which trainings are live (replace-by-slug keeps one row
 * per slug); the archive manifest enriches it with headline/model/provenance
 * and may be absent if the archive was removed out of band.
 */
export interface TrainListEntry {
  /** Slug parsed from the `train:<slug>` tag; the stable training identity. */
  slug: string;
  /** Observation row id; also the archive folder name under ~/.duet/train/. */
  memoryId: string;
  /** Unix ms the row was written; lists are sorted newest-first by this. */
  createdAt: number;
  /** YYYY-MM-DD the training was recorded. */
  observedDate: string;
  /** Headline from the archive manifest, when the archive is present. */
  headline?: string;
  /** Synthesis model id from the manifest, when present. */
  model?: string;
  /** Absolute corpus folder passed to `duet train`, from the manifest. */
  sourceFolder?: string;
  /** Number of archived source files, from the manifest. */
  fileCount?: number;
  /** False when the manifest could not be read (archive deleted/moved). */
  hasArchive: boolean;
}

/** A {@link TrainListEntry} plus the full synthesized observation text and
 *  archive contents, as returned by a single-row lookup (`duet train show` /
 *  `update`). */
export interface TrainRecord extends TrainListEntry {
  /** The durable memory text stored in the observation row. */
  content: string;
  /** Absolute paths of the archived copies under the archive's `files/`
   *  folder, from the manifest. Preferred over the original source paths,
   *  which may have moved or been deleted since training. */
  files?: string[];
}

export interface TrainManifest {
  /** Matches the inserted observation row's id; also the archive folder name. */
  memoryId: string;
  slug: string;
  /** Unix ms; matches the observation's createdAt. */
  createdAt: number;
  /** Absolute path the user passed to `duet train`. */
  sourceFolder: string;
  /** Resolved model id used for synthesis. */
  model: string;
  headline: string;
  files: Array<Pick<ArchivedFile, "relPath" | "bytes" | "sha256">>;
}
