/**
 * Skills are the extensibility layer of duet-agent.
 *
 * A skill is a self-contained unit of capability: a system prompt fragment,
 * tool definitions, and reference docs. Skills can live locally (files on disk)
 * or remotely (fetched from a URL or registry).
 *
 * Key design choice: skills are just files. A skill file is a JSON/YAML doc
 * that describes what the skill does, what tools it provides, and links to
 * reference documentation. No runtime code — the agent reads the skill
 * definition and uses it to inform its behavior.
 */

import type { z } from "zod";

/** A resolved skill ready for use by agents. */
export interface Skill {
  /** Unique identifier (e.g., "github", "crm-update", "web-scraper"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this skill enables the agent to do. */
  description: string;
  /** System prompt fragment injected when this skill is active. */
  instructions: string;
  /** Tool names this skill provides or requires. */
  tools: string[];
  /** Whether using this skill has side effects (writes to external systems). */
  hasSideEffects: boolean;
  /** Tags for discovery and filtering. */
  tags: string[];
  /** Reference docs — resolved content from linked URLs. */
  references: SkillReference[];
  /** Where this skill was loaded from. */
  source: SkillSource;
}

export interface SkillReference {
  /** Title of the reference doc. */
  title: string;
  /** The content (fetched and resolved). */
  content: string;
  /** Original URL if remote. */
  url?: string;
}

export type SkillSource =
  | { kind: "local"; path: string }
  | { kind: "remote"; url: string }
  | { kind: "registry"; registryUrl: string; skillId: string };

/** Raw skill file format (what's on disk or fetched from URL). */
export interface SkillFile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools?: string[];
  /** Declare whether this skill causes side effects. Default: false. */
  sideEffects?: boolean;
  tags?: string[];
  /** URLs to reference docs. These get fetched and included as context. */
  references?: string[];
}

/** A remote skill registry — a list of skill URLs at a single endpoint. */
export interface SkillRegistry {
  /** Registry name. */
  name: string;
  /** Base URL for resolving relative skill paths. */
  baseUrl: string;
  /** List of skill file paths (relative to baseUrl or absolute URLs). */
  skills: string[];
}

/** Options for skill discovery. */
export interface SkillDiscoveryOptions {
  /** Local directories to scan for skill files. */
  localPaths?: string[];
  /** Remote skill file URLs to fetch. */
  remoteUrls?: string[];
  /** Remote registry URLs to bulk-load from. */
  registryUrls?: string[];
  /** Max depth for following reference links. */
  maxReferenceDepth?: number;
  /** Timeout for fetching remote resources (ms). */
  fetchTimeoutMs?: number;
}
