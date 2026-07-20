import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { defaultBuildLogger, Template } from "e2b";

import { e2bTemplateName, shellQuote } from "./support.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const REPOSITORY_URL = "https://github.com/dzhng/duet-agent.git";

/** Build the immutable x86 Docker worker image used by an E2B campaign. */
export async function buildSwebenchTemplate(): Promise<{
  name: string;
  templateId?: string;
  repositorySha: string;
}> {
  const [{ stdout: shaOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: REPO_ROOT }),
  ]);
  if (statusOutput.trim()) {
    throw new Error("E2B template build requires a clean committed worktree.");
  }
  const repositorySha = shaOutput.trim();
  const name = e2bTemplateName(repositorySha);
  if (await Template.exists(name)) return { name, repositorySha };

  const repo = shellQuote(REPOSITORY_URL);
  const sha = shellQuote(repositorySha);
  const worktree = "/work/duet-agent";
  const template = Template()
    .fromUbuntuImage("24.04")
    .aptInstall([
      "ca-certificates",
      "curl",
      "git",
      "python3",
      "python3-pip",
      "python3-venv",
      "unzip",
    ])
    .runCmd("curl -fsSL https://get.docker.com | sh")
    .runCmd("sudo systemctl disable --now docker.service docker.socket")
    .runCmd(
      "curl -fsSL https://bun.sh/install | bash -s 'bun-v1.3.11' && sudo ln -sf /home/user/.bun/bin/bun /usr/local/bin/bun",
    )
    .runCmd(
      `sudo mkdir -p /work && sudo chown user:user /work && git clone ${repo} ${worktree} && git -C ${worktree} checkout ${sha}`,
    )
    .runCmd(`cd ${worktree} && bun install --frozen-lockfile`)
    .runCmd(
      `python3 -m venv ${worktree}/benchmarks/swebench/.venv && ${worktree}/benchmarks/swebench/.venv/bin/pip install --no-cache-dir swebench==4.1.0 mini-swe-agent==2.4.5`,
    )
    .runCmd(`sudo usermod -aG docker user && sudo chown -R user:user ${worktree}`)
    .setStartCmd(
      "sudo dockerd --host=unix:///var/run/docker.sock >/tmp/duet-swebench-dockerd.log 2>&1",
      "sudo docker info >/dev/null",
    );

  const built = await Template.build(template, name, {
    cpuCount: 8,
    memoryMB: 16_384,
    onBuildLogs: defaultBuildLogger(),
  });
  return { name, templateId: built.templateId, repositorySha };
}

if (import.meta.main) {
  const built = await buildSwebenchTemplate();
  console.log(
    `E2B template ${built.name} is ready for duet commit ${built.repositorySha.slice(0, 12)}.`,
  );
}
