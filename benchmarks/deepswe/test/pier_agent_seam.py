from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from benchmarks.deepswe.pier_agent import DuetAgent
from pier.models.agent.context import AgentContext


class FakeEnvironment:
    """Minimal Pier seam proving artifact, workdir, commit, and egress behavior."""

    def __init__(self) -> None:
        self.run_env: dict[str, str] | None = None
        self.run_cwd: str | None = None
        self.commands: list[tuple[str, str | None]] = []
        self.uploads: list[tuple[str, str]] = []

    def agent_process_env(
        self, env: dict[str, str] | None
    ) -> dict[str, str] | None:
        return {**(env or {}), "HTTPS_PROXY": "http://pier-filtered-egress"}

    async def exec(self, command: str, **kwargs):
        self.commands.append((command, kwargs.get("cwd")))
        if command.startswith("/opt/duet/deepswe-agent-driver"):
            self.run_env = kwargs.get("env")
            self.run_cwd = kwargs.get("cwd")
        return SimpleNamespace(return_code=0, stdout="", stderr="")

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads.append((str(source_path), target_path))


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="duet-deepswe-pier-seam-") as temp:
        root = Path(temp)
        logs = root / "logs"
        logs.mkdir()
        config = root / "models.json"
        config.write_text("{}\n", encoding="utf-8")
        files = []
        for name in [
            "duet",
            "driver",
            "pglite.wasm",
            "pglite.data",
            "initdb.wasm",
            "vector.tar.gz",
        ]:
            path = root / name
            path.write_text(name, encoding="utf-8")
            files.append(
                {
                    "path": name,
                    "sha256": hashlib.sha256(name.encode("utf-8")).hexdigest(),
                }
            )
        manifest = root / "artifact-manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "duetCommit": "a" * 40,
                    "duet": files[0],
                    "driver": files[1],
                    "runtimeAssets": files[2:],
                }
            ),
            encoding="utf-8",
        )
        agent = DuetAgent(
            logs,
            routing_config_path=str(config),
            artifact_manifest_path=str(manifest),
            cost_limit_usd=1,
            model_name="seam",
        )
        if set(agent.network_allowlist().domains) != {
            "ai-gateway.vercel.sh",
            "gateway.duet.so",
            "openrouter.ai",
        }:
            raise AssertionError("Pier egress does not cover every supported gateway")
        environment = FakeEnvironment()
        await agent.setup(environment)
        await agent.run("test", environment, AgentContext())
        expected_targets = {
            "/opt/duet/duet",
            "/opt/duet/deepswe-agent-driver",
            "/opt/duet/pglite.wasm",
            "/opt/duet/pglite.data",
            "/opt/duet/initdb.wasm",
            "/opt/duet/vector.tar.gz",
            "/opt/duet/home/.duet/models.json",
        }
        if {target for _, target in environment.uploads} != expected_targets:
            raise AssertionError("Pier adapter did not upload the exact runtime payload")
        if environment.run_env is None:
            raise AssertionError("Duet command did not execute")
        if environment.run_cwd != "/app":
            raise AssertionError("Duet did not run in the official task workdir")
        if environment.run_env.get("HTTPS_PROXY") != "http://pier-filtered-egress":
            raise AssertionError("Pier filtered-egress proxy did not reach Duet")
        if environment.run_env.get("HOME") != "/opt/duet/home":
            raise AssertionError("Duet runtime environment was not retained")
        if not any(
            "git commit --allow-empty" in command and cwd == "/app"
            for command, cwd in environment.commands
        ):
            raise AssertionError("Agent work was not committed for pre_artifacts.sh")


asyncio.run(main())
