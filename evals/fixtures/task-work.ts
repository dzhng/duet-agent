import { watch } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface FixtureOptions {
  startedFile: string;
  pidFile: string;
  releaseFile: string;
  stoppedFile: string;
  stdout: string;
  stderr: string;
}

const options = parseOptions(process.argv.slice(2));
let stopping = false;

process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  void recordStopAndExit();
});

await Promise.all([
  writeMarker(options.startedFile, "started\n"),
  writeMarker(options.pidFile, `${process.pid}\n`),
]);
process.stdout.write(options.stdout);
process.stderr.write(options.stderr);

await waitForRelease(options.releaseFile);
if (!stopping) process.exit(0);

async function recordStopAndExit(): Promise<void> {
  try {
    await writeMarker(options.stoppedFile, `SIGTERM ${process.pid}\n`);
  } finally {
    process.exit(143);
  }
}

async function waitForRelease(path: string): Promise<void> {
  if (await exists(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await waitForPathEvent(path);
}

function waitForPathEvent(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let checking = false;
    const watcher = watch(dirname(path), checkPath);
    watcher.once("error", reject);
    void checkPath();

    function checkPath(): void {
      if (checking) return;
      checking = true;
      void exists(path).then(
        (found) => {
          checking = false;
          if (!found) return;
          watcher.close();
          resolve();
        },
        (error: unknown) => {
          watcher.close();
          reject(error);
        },
      );
    }
  });
}

async function writeMarker(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseOptions(args: string[]): FixtureOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received: ${args.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }

  return {
    startedFile: required(values, "started-file"),
    pidFile: required(values, "pid-file"),
    releaseFile: required(values, "release-file"),
    stoppedFile: required(values, "stopped-file"),
    stdout: values.get("stdout") ?? "",
    stderr: values.get("stderr") ?? "",
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing required --${key} argument`);
  return value;
}
