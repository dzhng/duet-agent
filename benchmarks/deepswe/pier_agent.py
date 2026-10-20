from __future__ import annotations

import base64
import hashlib
import json
import shlex
from pathlib import Path
from typing import Any

from pier.agents.installed.base import BaseInstalledAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist


class DuetAgent(BaseInstalledAgent):
    """Pier adapter that installs and drives one immutable Duet build."""

    def __init__(
        self,
        logs_dir: Path,
        routing_config_path: str,
        artifact_manifest_path: str,
        cost_limit_usd: float,
        wall_clock_ms: int = 5_300_000,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        self.routing_config_path = Path(routing_config_path).resolve()
        self.artifact_manifest_path = Path(artifact_manifest_path).resolve()
        self.artifact_dir = self.artifact_manifest_path.parent
        self.artifact_manifest = json.loads(
            self.artifact_manifest_path.read_text(encoding="utf-8")
        )
        self.cost_limit_usd = float(cost_limit_usd)
        self.wall_clock_ms = int(wall_clock_ms)
        if self.cost_limit_usd <= 0:
            raise ValueError("cost_limit_usd must be positive")
        if self.wall_clock_ms <= 0:
            raise ValueError("wall_clock_ms must be positive")
        for file_info in [
            self.artifact_manifest["duet"],
            self.artifact_manifest["driver"],
            *self.artifact_manifest["runtimeAssets"],
        ]:
            source = self.artifact_dir / file_info["path"]
            actual = hashlib.sha256(source.read_bytes()).hexdigest()
            if actual != file_info["sha256"]:
                raise ValueError(f"Artifact hash changed: {file_info['path']}")
        super().__init__(
            logs_dir,
            version=self.artifact_manifest["duetCommit"],
            *args,
            **kwargs,
        )

    @staticmethod
    def name() -> str:
        return "duet"

    def install_spec(self) -> AgentInstallSpec:
        # The binary is uploaded in setup. A stable no-op spec lets Pier include
        # the exact Duet payload in its environment build/cache identity.
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self.version(),
            steps=[InstallStep(run="true", user="root")],
            cache_key=self.artifact_manifest["duet"]["sha256"],
        )

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(
            domains=[
                "gateway.duet.so",
                "ai-gateway.vercel.sh",
                "openrouter.ai",
            ]
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        directory_result = await environment.exec(
            command=(
                "mkdir -p /opt/duet/home/.duet /logs/agent "
                "&& chmod 777 /opt/duet /opt/duet/home /opt/duet/home/.duet /logs/agent"
            ),
            user="root",
        )
        if directory_result.return_code != 0:
            raise RuntimeError(
                f"Failed to prepare Duet directories: {directory_result.stderr}"
            )
        await self._upload_manifest_file(environment, "duet", "/opt/duet/duet")
        await self._upload_manifest_file(
            environment, "driver", "/opt/duet/deepswe-agent-driver"
        )
        for asset in self.artifact_manifest["runtimeAssets"]:
            await environment.upload_file(
                self.artifact_dir / asset["path"], f"/opt/duet/{asset['path']}"
            )
        await environment.upload_file(
            self.routing_config_path, "/opt/duet/home/.duet/models.json"
        )
        setup_result = await environment.exec(
            command=(
                "chmod 755 /opt/duet/duet /opt/duet/deepswe-agent-driver "
                "&& chmod 644 /opt/duet/home/.duet/models.json "
                "/opt/duet/pglite.wasm /opt/duet/pglite.data "
                "/opt/duet/initdb.wasm /opt/duet/vector.tar.gz"
            ),
            user="root",
        )
        if setup_result.return_code != 0:
            raise RuntimeError(f"Failed to install Duet: {setup_result.stderr}")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        encoded_instruction = base64.b64encode(instruction.encode("utf-8")).decode(
            "ascii"
        )
        command = " ".join(
            [
                "/opt/duet/deepswe-agent-driver",
                "--duet",
                "/opt/duet/duet",
                "--instruction-base64",
                shlex.quote(encoded_instruction),
                "--events",
                "/logs/agent/events.ndjson",
                "--stderr",
                "/logs/agent/stderr.log",
                "--summary",
                "/logs/agent/summary.json",
                "--cost-usd",
                shlex.quote(str(self.cost_limit_usd)),
                "--wall-clock-ms",
                shlex.quote(str(self.wall_clock_ms)),
            ]
        )
        run_result = None
        try:
            run_result = await environment.exec(
                command=command,
                cwd="/app",
                env=environment.agent_process_env(
                    self.build_process_env(
                        {
                            "HOME": "/opt/duet/home",
                            "CI": "1",
                            "NO_COLOR": "1",
                        }
                    )
                ),
            )
        finally:
            # DeepSWE's pre_artifacts.sh deliberately captures BASE..HEAD, so
            # uncommitted changes would otherwise grade as an empty submission.
            commit_result = await environment.exec(
                command=(
                    "git config user.name 'Duet Benchmark' "
                    "&& git config user.email 'benchmark@duet.so' "
                    "&& git add -A "
                    "&& git commit --allow-empty -m 'DeepSWE agent result'"
                ),
                cwd="/app",
            )
            if commit_result.return_code != 0:
                raise RuntimeError(
                    f"Failed to commit DeepSWE agent result: {commit_result.stderr}"
                )
        if run_result is None or run_result.return_code != 0:
            stderr = run_result.stderr if run_result is not None else "driver did not start"
            raise RuntimeError(f"Duet driver failed: {stderr}")

    def populate_context_post_run(self, context: AgentContext) -> None:
        summary_path = self.logs_dir / "summary.json"
        if not summary_path.exists():
            self.logger.warning("Duet summary was not collected from the task container")
            return
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            telemetry = summary["telemetry"]
            tokens = telemetry["tokens"]
            context.n_input_tokens = int(tokens["input"]) + int(tokens["cacheRead"])
            context.n_cache_tokens = int(tokens["cacheRead"])
            context.n_output_tokens = int(tokens["output"])
            context.cost_usd = float(telemetry["costUsdTotal"])
            context.n_agent_steps = int(telemetry["steps"])
            context.metadata = {
                "terminal": summary["terminal"],
                "timedOut": summary["timedOut"],
                "wallClockMs": summary["wallClockMs"],
                "usageByModel": telemetry["usageByModel"],
                "advisorCalls": telemetry["advisorCalls"],
                "routerSwitches": telemetry["routerSwitches"],
            }
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            # Accounting failure cannot invalidate an otherwise gradeable patch.
            self.logger.exception("Failed to read Duet usage summary")

    async def _upload_manifest_file(
        self, environment: BaseEnvironment, key: str, target: str
    ) -> None:
        file_info = self.artifact_manifest[key]
        await environment.upload_file(self.artifact_dir / file_info["path"], target)
