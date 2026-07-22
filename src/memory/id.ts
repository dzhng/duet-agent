import { nanoid } from "nanoid";

/** Generate the stable `mem_…` identifier shared by every memory backend. */
export function createMemoryId(): string {
  return `mem_${nanoid(12)}`;
}
