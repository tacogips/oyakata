import {
  AdapterExecutionError,
  normalizeAdapterOutput,
  type AdapterExecutionContext,
  type AdapterExecutionInput,
  type AdapterExecutionOutput,
  type NodeAdapter,
} from "../adapter";

const DEFAULT_CLAUDE_ENDPOINT = "http://127.0.0.1:7070/claude/execute";
const DEFAULT_CLAUDE_API_KEY_ENV = "CLAUDE_API_KEY";

export interface ClaudeAdapterConfig {
  readonly endpoint?: string;
  readonly apiKeyEnv?: string;
}

function resolveApiKey(config: ClaudeAdapterConfig): string | undefined {
  const keyEnv = config.apiKeyEnv ?? DEFAULT_CLAUDE_API_KEY_ENV;
  const value = process.env[keyEnv];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class ClaudeCodeAgentAdapter implements NodeAdapter {
  readonly #config: ClaudeAdapterConfig;

  constructor(config: ClaudeAdapterConfig = {}) {
    this.#config = config;
  }

  async execute(input: AdapterExecutionInput, context: AdapterExecutionContext): Promise<AdapterExecutionOutput> {
    const endpoint = this.#config.endpoint ?? DEFAULT_CLAUDE_ENDPOINT;
    const apiKey = resolveApiKey(this.#config);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (apiKey !== undefined) {
      headers["authorization"] = `Bearer ${apiKey}`;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        signal: context.signal,
        body: JSON.stringify({
          workflowId: input.workflowId,
          nodeId: input.nodeId,
          model: input.node.model,
          promptText: input.promptText,
          arguments: input.arguments,
          mergedVariables: input.mergedVariables,
          executionIndex: input.executionIndex,
        }),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AdapterExecutionError("policy_blocked", `claude adapter request blocked (${response.status})`);
        }
        if (response.status === 408 || response.status === 504) {
          throw new AdapterExecutionError("timeout", `claude adapter request timeout (${response.status})`);
        }
        throw new AdapterExecutionError("provider_error", `claude adapter request failed (${response.status})`);
      }

      const payload = (await response.json()) as unknown;
      return normalizeAdapterOutput(payload, input.node.model);
    } catch (error: unknown) {
      if (error instanceof AdapterExecutionError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new AdapterExecutionError("timeout", "claude adapter aborted by timeout");
      }
      const message = error instanceof Error ? error.message : "unknown claude adapter failure";
      throw new AdapterExecutionError("provider_error", message);
    }
  }
}
