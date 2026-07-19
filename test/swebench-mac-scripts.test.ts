import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const scripts = [
  "benchmarks/swebench/mac/provision.sh",
  "benchmarks/swebench/mac/gold-check.sh",
  "benchmarks/swebench/mac/score.sh",
];

describe("SWE-bench Mac scripts", () => {
  for (const script of scripts) {
    test(`${script} has valid bash syntax`, () => {
      const result = Bun.spawnSync(["bash", "-n", resolve(script)]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("gold-check documents its manifest and one-instance entry points", () => {
    const result = Bun.spawnSync(["bash", resolve(scripts[1]!), "--help"]);
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("--manifest PATH");
    expect(output).toContain("--instance-id ID");
  });
});
