#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { defaultBuildLogger, Template } from "e2b";

import { deepSweTemplateName, shellQuote } from "./support.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const REPOSITORY_URL = "https://github.com/dzhng/duet-agent.git";
const REQUEST_TIMEOUT_MS = 180_000;
export const DEEPSWE_TEMPLATE_APT_PACKAGES = [
  "ca-certificates",
  "curl",
  "git",
  "python3",
  "python3-pip",
  "python3-venv",
  "unzip",
] as const;

/** Build one immutable Docker-in-Docker worker image for the DeepSWE pilot. */
export async function buildDeepSweTemplate(): Promise<{
  name: string;
  templateId?: string;
  repositorySha: string;
}> {
  const [{ stdout: sha }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: REPO_ROOT }),
  ]);
  if (status.trim()) throw new Error("E2B template build requires a clean committed worktree.");
  const repositorySha = sha.trim();
  const name = deepSweTemplateName(repositorySha);
  if (await Template.exists(name, { requestTimeoutMs: REQUEST_TIMEOUT_MS })) {
    return { name, repositorySha };
  }

  const worktree = "/work/duet-agent";
  const template = Template()
    .fromUbuntuImage("24.04")
    .aptInstall([...DEEPSWE_TEMPLATE_APT_PACKAGES])
    .runCmd("curl -fsSL https://get.docker.com | sh")
    .runCmd("sudo systemctl disable --now docker.service docker.socket")
    .runCmd(
      "curl -fsSL https://bun.sh/install | bash -s 'bun-v1.3.11' && sudo ln -sf /home/user/.bun/bin/bun /usr/local/bin/bun",
    )
    .runCmd(
      `sudo mkdir -p /work && sudo chown user:user /work && git clone ${shellQuote(REPOSITORY_URL)} ${worktree} && git -C ${worktree} checkout ${shellQuote(repositorySha)}`,
    )
    .runCmd(`cd ${worktree} && bun install --frozen-lockfile`)
    .runCmd(`cd ${worktree} && bun benchmarks/deepswe/cli.ts setup`)
    .runCmd(`sudo usermod -aG docker user && sudo chown -R user:user ${worktree}`)
    .setStartCmd(
      "sudo dockerd --host=unix:///var/run/docker.sock >/tmp/duet-deepswe-dockerd.log 2>&1",
      "sudo docker info >/dev/null",
    );

  const built = await Template.build(template, name, {
    cpuCount: 8,
    memoryMB: 16_384,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    onBuildLogs: defaultBuildLogger(),
  });
  return { name, templateId: built.templateId, repositorySha };
}

if (import.meta.main) {
  const built = await buildDeepSweTemplate();
  console.log(`E2B template ${built.name} is ready for Duet ${built.repositorySha.slice(0, 12)}.`);
}
