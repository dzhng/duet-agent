/**
 * duet-agent — An opinionated full-stack agent harness.
 *
 * Native memories. Native interrupts. Multi-agent by default.
 * No MCP — everything is files and CLI.
 */

export * from "./core/types.js";
export * from "./core/ids.js";
export * from "./core/layers.js";
export * from "./core/bridges.js";
export * from "./core/structured-output.js";

export * from "./memory/store.js";
export * from "./memory/observational.js";
export * from "./memory/observation-groups.js";
export * from "./interrupt/controller.js";
export * from "./orchestrator/orchestrator.js";
export * from "./orchestrator/sub-agent.js";
export * from "./comm/stdio.js";
export type * from "./comm/adapter.js";
export * from "./guardrails/semantic.js";
export * from "./guardrails/pattern.js";
export * from "./guardrails/firewall.js";
export * from "./agents/index.js";
