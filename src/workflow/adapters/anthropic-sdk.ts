import Anthropic from "@anthropic-ai/sdk";
import {
  AdapterExecutionError,
  type AdapterExecutionContext,
  type AdapterExecutionInput,
  type AdapterExecutionOutput,
  type NodeAdapter,
} from "../adapter";

const DEFAULT_ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const DEFAULT_ANTHROPIC_MAX_ATTEMPTS = 2;
const DEFAULT_ANTHROPIC_RETRY_DELAY_MS = 50;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;

interface AnthropicMessagesClient {
  create(request: {
    readonly model: string;
    readonly max_tokens: number;
    readonly messages: ReadonlyArray<{
      readonly role: "user";
      readonly content: string;
    }>;
  }): Promise<unknown>;
}

interface AnthropicClientLike {
  readonly messages: AnthropicMessagesClient;
}

export interface AnthropicSdkAdapterConfig {
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly maxTokens?: number;
  readonly clientFactory?: (args: {
    readonly apiKey: string;
    readonly baseURL?: string;
  }) => AnthropicClientLike;
}

function resolveApiKey(config: AnthropicSdkAdapterConfig): string | undefined {
  const keyEnv = config.apiKeyEnv ?? DEFAULT_ANTHROPIC_API_KEY_ENV;
  const value = process.env[keyEnv];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAnthropicText(response: unknown): string {
  if (!isRecord(response)) {
    return "";
  }
  const content = response["content"];
  if (!Array.isArray(content)) {
    return "";
  }

  const segments: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry["type"] !== "text") {
      continue;
    }
    const text = entry["text"];
    if (typeof text === "string" && text.length > 0) {
      segments.push(text);
    }
  }
  return segments.join("\n");
}

function defaultClientFactory(args: { readonly apiKey: string; readonly baseURL?: string }): AnthropicClientLike {
  return new Anthropic({
    apiKey: args.apiKey,
    ...(args.baseURL === undefined ? {} : { baseURL: args.baseURL }),
  }) as unknown as AnthropicClientLike;
}

export class AnthropicSdkAdapter implements NodeAdapter {
  readonly #config: AnthropicSdkAdapterConfig;

  constructor(config: AnthropicSdkAdapterConfig = {}) {
    this.#config = config;
  }

  async execute(input: AdapterExecutionInput, context: AdapterExecutionContext): Promise<AdapterExecutionOutput> {
    const apiKey = resolveApiKey(this.#config);
    if (apiKey === undefined) {
      throw new AdapterExecutionError("policy_blocked", "missing Anthropic API key");
    }

    const clientFactory = this.#config.clientFactory ?? defaultClientFactory;
    const client = clientFactory({
      apiKey,
      ...(this.#config.baseUrl === undefined ? {} : { baseURL: this.#config.baseUrl }),
    });
    const maxAttempts = Math.max(1, this.#config.maxAttempts ?? DEFAULT_ANTHROPIC_MAX_ATTEMPTS);
    const retryDelayMs = Math.max(0, this.#config.retryDelayMs ?? DEFAULT_ANTHROPIC_RETRY_DELAY_MS);
    const maxTokens = Math.max(1, this.#config.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await client.messages.create({
          model: input.node.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: input.promptText }],
        });

        const text = extractAnthropicText(response);
        return {
          provider: "official-anthropic-sdk",
          model: input.node.model,
          promptText: input.promptText,
          completionPassed: true,
          when: { always: true },
          payload: {
            text,
            response: isRecord(response) ? response : {},
          },
        };
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new AdapterExecutionError("timeout", "official Anthropic SDK request aborted");
        }
        if (context.signal.aborted) {
          throw new AdapterExecutionError("timeout", "official Anthropic SDK request aborted");
        }

        const normalized =
          error instanceof AdapterExecutionError
            ? error
            : new AdapterExecutionError(
                "provider_error",
                error instanceof Error ? error.message : "unknown Anthropic SDK failure",
              );

        const retryable = normalized.code === "provider_error" || normalized.code === "timeout";
        if (attempt < maxAttempts && retryable && !context.signal.aborted) {
          if (retryDelayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
          }
          continue;
        }
        throw normalized;
      }
    }

    throw new AdapterExecutionError("provider_error", "official Anthropic SDK adapter exhausted retries");
  }
}
