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
  /** Rendered AGENTS.md body. Written verbatim to <folder>/AGENTS.md by the sub-agent. */
  agentsMd: string;
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
  /** Absolute path of the AGENTS.md the sub-agent wrote. */
  agentsMdPath: string;
}
