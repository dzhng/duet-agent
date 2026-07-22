import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteEntry,
  discoverMemoryStores,
  listStore,
  updateEntry,
  writeEntry,
} from "../src/memory/store/index.js";

const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-store-example-"));
const agentRoot = join(root, "agent");
const childRoot = join(agentRoot, "children", "researcher");
const rootStore = join(agentRoot, ".agents", "memories");
const childStore = join(agentRoot, "children", ".duet", "memories");

try {
  await fileSystem.mkdir(childRoot, { recursive: true });
  await writeEntry(rootStore, {
    slug: "operating-note",
    version: 1,
    id: "mem_operating_note",
    kind: "note",
    createdAt: Date.now(),
    content: "Escalate blocked jobs with their last verified state.\n",
  });
  await writeEntry(childStore, {
    slug: "research-guide",
    version: 1,
    id: "mem_research_guide",
    kind: "train",
    createdAt: Date.now(),
    headline: "Research guide",
    model: "opus-4.8",
    fileCount: 4,
    content: "Prefer primary sources and retain exact dates.\n",
  });

  const stores = await discoverMemoryStores(childRoot);
  console.log("Nearest-first stores:", stores);
  console.log("Initial records:", (await Promise.all(stores.map(listStore))).flat());

  await updateEntry(childStore, "research-guide", "Prefer primary sources and quote dates.\n");
  await deleteEntry(rootStore, "operating-note");
  console.log("After update/delete:", (await Promise.all(stores.map(listStore))).flat());
} finally {
  await fileSystem.rm(root, { recursive: true, force: true });
}
