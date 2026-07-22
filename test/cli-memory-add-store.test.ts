import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { describe, expect } from "bun:test";

import { runMemoryAddCommand } from "../src/cli/memory-add.js";
import { runTrainCommand } from "../src/cli/train.js";
import { parseMemoryFile } from "../src/memory/store/file.js";
import { listStore, writeEntry } from "../src/memory/store/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("duet memory add file stores", () => {
  testIfDocker("writes note frontmatter and derives a collision-safe content slug", async () => {
    const dir = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-add-store-"));
    const store = join(dir, "memories");
    try {
      const first = makeIo();
      await runMemoryAddCommand(
        [
          "--store",
          store,
          "--priority",
          "high",
          "--source",
          "import",
          "--tag",
          "pets",
          "--json",
          "Doughy doubles in 4 hours",
        ],
        first.io,
      );
      const emitted = JSON.parse(first.output());
      expect(emitted.slug).toMatch(/^doughy-doubles-in-4-hours-[0-9a-f]{6}$/);
      expect(emitted).toMatchObject({
        id: expect.stringMatching(/^mem_/),
        kind: "note",
        content: "Doughy doubles in 4 hours",
        priority: "high",
        source: "import",
        tags: ["pets"],
        store,
      });

      const raw = await fileSystem.readFile(join(store, `${emitted.slug}.md`), "utf8");
      expect(parseMemoryFile(raw)).toMatchObject({
        id: emitted.id,
        kind: "note",
        content: "Doughy doubles in 4 hours",
        priority: "high",
        source: "import",
        tags: ["pets"],
      });

      const second = makeIo();
      await runMemoryAddCommand(
        ["--store", store, "--json", "Doughy doubles in 4 hours"],
        second.io,
      );
      const secondSlug = JSON.parse(second.output()).slug;
      expect(secondSlug).not.toBe(emitted.slug);
      expect((await listStore(store)).map((entry) => entry.slug).sort()).toEqual(
        [emitted.slug, secondSlug].sort(),
      );

      const shown = outputStream();
      await runTrainCommand(["show", emitted.slug, "--store", store, "--json"], {
        stdout: shown.stream,
        stderr: outputStream().stream,
      });
      expect(JSON.parse(shown.output())).toMatchObject({
        slug: emitted.slug,
        content: "Doughy doubles in 4 hours",
        store,
      });

      const edited = join(dir, "edited.md");
      await fileSystem.writeFile(edited, "Doughy doubles in 3 hours");
      await runTrainCommand(["update", emitted.slug, "--store", store, "--content-file", edited], {
        stdout: outputStream().stream,
        stderr: outputStream().stream,
      });
      expect((await listStore(store)).find((entry) => entry.slug === emitted.slug)?.content).toBe(
        "Doughy doubles in 3 hours",
      );

      await runTrainCommand(["delete", emitted.slug, "--store", store], {
        stdout: outputStream().stream,
        stderr: outputStream().stream,
      });
      expect((await listStore(store)).map((entry) => entry.slug)).toEqual([secondSlug]);
    } finally {
      await fileSystem.rm(dir, { recursive: true, force: true });
    }
  });

  testIfDocker(
    "flagless add creates memories under the nearest ancestor .agents directory",
    async () => {
      const root = await fileSystem.mkdtemp(join(tmpdir(), "duet-memory-add-discovery-"));
      const child = join(root, "child");
      const work = join(child, "work");
      const childStore = join(child, ".agents", "memories");
      const rootStore = join(root, ".agents", "memories");
      try {
        await fileSystem.mkdir(join(child, ".agents"), { recursive: true });
        await fileSystem.mkdir(work, { recursive: true });
        await writeEntry(rootStore, {
          slug: "inherited",
          version: 1,
          id: "mem_inherited",
          kind: "note",
          createdAt: 1,
          content: "Inherited root note",
        });

        const output = makeIo(work);
        await runMemoryAddCommand(["Nearest agent note"], output.io);

        const childEntries = await listStore(childStore);
        expect(childEntries).toHaveLength(1);
        expect(childEntries[0]?.content).toBe("Nearest agent note");
        expect((await listStore(rootStore)).map((entry) => entry.slug)).toEqual(["inherited"]);
      } finally {
        await fileSystem.rm(root, { recursive: true, force: true });
      }
    },
  );
});

function makeIo(cwd?: string) {
  const stdout = outputStream();
  const stdin = Object.assign(Readable.from([]), { isTTY: true });
  return {
    io: {
      stdout: stdout.stream,
      stdin,
      ...(cwd ? { cwd } : {}),
    },
    output: stdout.output,
  };
}

function outputStream() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream: stream as NodeJS.WritableStream,
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}
