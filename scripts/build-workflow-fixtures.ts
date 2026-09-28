import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "evals/fixtures/workflow-reliability");
const files: Record<string, string> = {};
for (const name of (await readdir(join(source, "app"))).sort()) {
  files[name] = await readFile(join(source, "app", name), "utf8");
}
const scenarios = JSON.parse(await readFile(join(source, "scenarios.json"), "utf8"));
const archive = `${JSON.stringify({ ...scenarios, files })}\n`;
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = join(root, "dist/eval-fixtures/workflow-reliability.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive);
await writeFile(
  join(dirname(output), "manifest.json"),
  `${JSON.stringify({ packageVersion: packageJson.version, sha256: createHash("sha256").update(archive).digest("hex") })}\n`,
);
