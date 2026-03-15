import {
  AdapterExecutionError,
  type AdapterExecutionContext,
  type AdapterExecutionInput,
  type AdapterExecutionOutput,
  type NodeAdapter,
} from "../adapter";
import type {
  CliAgentBackend,
  NodeExecutionBackend,
  NodePayload,
} from "../types";
import {
  AnthropicSdkAdapter,
  type AnthropicSdkAdapterConfig,
} from "./anthropic-sdk";
import { ClaudeCodeAgentAdapter, type ClaudeAdapterConfig } from "./claude";
import { CodexAgentAdapter, type CodexAdapterConfig } from "./codex";
import { OpenAiSdkAdapter, type OpenAiSdkAdapterConfig } from "./openai-sdk";

export interface DispatchingNodeAdapterConfig {
  readonly codexAgent?: CodexAdapterConfig;
  readonly claudeCodeAgent?: ClaudeAdapterConfig;
  readonly openAiSdk?: OpenAiSdkAdapterConfig;
  readonly anthropicSdk?: AnthropicSdkAdapterConfig;
}

function isCliAgentBackend(value: string): value is CliAgentBackend {
  return (
    value === "tacogips/codex-agent" || value === "tacogips/claude-code-agent"
  );
}

export function resolveNodeExecutionBackend(
  node: NodePayload,
): NodeExecutionBackend {
  if (node.executionBackend !== undefined) {
    return node.executionBackend;
  }
  if (isCliAgentBackend(node.model)) {
    return node.model;
  }
  throw new AdapterExecutionError(
    "provider_error",
    `node '${node.id}' requires executionBackend when model '${node.model}' is not a tacogips CLI-wrapper backend`,
  );
}

export class DispatchingNodeAdapter implements NodeAdapter {
  readonly #codexAgent: NodeAdapter;
  readonly #claudeCodeAgent: NodeAdapter;
  readonly #openAiSdk: NodeAdapter;
  readonly #anthropicSdk: NodeAdapter;

  constructor(config: DispatchingNodeAdapterConfig = {}) {
    this.#codexAgent = new CodexAgentAdapter(config.codexAgent);
    this.#claudeCodeAgent = new ClaudeCodeAgentAdapter(config.claudeCodeAgent);
    this.#openAiSdk = new OpenAiSdkAdapter(config.openAiSdk);
    this.#anthropicSdk = new AnthropicSdkAdapter(config.anthropicSdk);
  }

  execute(
    input: AdapterExecutionInput,
    context: AdapterExecutionContext,
  ): Promise<AdapterExecutionOutput> {
    switch (resolveNodeExecutionBackend(input.node)) {
      case "tacogips/codex-agent":
        return this.#codexAgent.execute(input, context);
      case "tacogips/claude-code-agent":
        return this.#claudeCodeAgent.execute(input, context);
      case "official/openai-sdk":
        return this.#openAiSdk.execute(input, context);
      case "official/anthropic-sdk":
        return this.#anthropicSdk.execute(input, context);
    }
  }
}
