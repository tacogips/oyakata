import type { CliAgentBackend, NodeExecutionBackend } from "./types";

type CliAgentBackendAlias =
  | CliAgentBackend
  | "tacogips/codex-agent"
  | "tacogips/claude-code-agent";

export function normalizeCliAgentBackend(
  value: unknown,
): CliAgentBackend | null {
  switch (value) {
    case "codex-agent":
    case "tacogips/codex-agent":
      return "codex-agent";
    case "claude-code-agent":
    case "tacogips/claude-code-agent":
      return "claude-code-agent";
    default:
      return null;
  }
}

export function isCliAgentBackend(value: unknown): value is CliAgentBackendAlias {
  return normalizeCliAgentBackend(value) !== null;
}

export function normalizeNodeExecutionBackend(
  value: unknown,
): NodeExecutionBackend | null {
  const cliBackend = normalizeCliAgentBackend(value);
  if (cliBackend !== null) {
    return cliBackend;
  }
  switch (value) {
    case "official/openai-sdk":
    case "official/anthropic-sdk":
      return value;
    default:
      return null;
  }
}
