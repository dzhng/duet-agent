import { homedir } from "node:os";
import { join } from "node:path";

/** Directory name shared by Duet's user-scoped runtime state. */
export const DEFAULT_DUET_DIR = ".duet";
/** Absolute user-scoped root for sessions, memory, and private train archives. */
export const DEFAULT_DUET_HOME = join(homedir(), DEFAULT_DUET_DIR);
/** Default durable session snapshot directory. */
export const DEFAULT_SESSION_STORAGE_DIR = join(DEFAULT_DUET_HOME, "sessions");
/** Default legacy observational-memory PGlite path. */
export const DEFAULT_MEMORY_DB_PATH = join(DEFAULT_DUET_HOME, "memory.db");
