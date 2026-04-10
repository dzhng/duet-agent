import type { CommLayer } from "../core/types.js";

/**
 * CommAdapter is the minimal interface for plugging in a new
 * communication channel. The agent logic doesn't know or care
 * whether it's talking to a terminal, a voice call, a video stream,
 * or a Slack channel.
 *
 * Examples:
 * - StdioComm: terminal-based text I/O (default)
 * - VoiceComm: wraps gpt-realtime for voice I/O
 * - VideoComm: translates screen captures to text descriptions
 * - WebSocketComm: real-time web interface
 * - SlackComm: Slack channel as the comm surface
 *
 * The decoupling is key: agent logic (orchestrator, sub-agents, memory)
 * never imports from comm. Comm never imports from orchestrator.
 * They only share the CommLayer interface from core/types.
 */
export type CommAdapter = CommLayer;
