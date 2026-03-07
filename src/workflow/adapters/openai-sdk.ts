import OpenAI from "openai";
import {
  AdapterExecutionError,
  parseJsonObjectCandidate,
  type AdapterExecutionContext,
  type AdapterExecutionInput,
  type AdapterExecutionOutput,
  type NodeAdapter,
} from "../adapter";

const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_OPENAI_MAX_ATTEMPTS = 2;
const DEFAULT_OPENAI_RETRY_DELAY_MS = 50;

interface OpenAiResponsesClient {
  create(request: {
    readonly model: string;
    readonly input: string;
  }, options?: {
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

interface OpenAiClientLike {
  readonly responses: OpenAiResponsesClient;
}

export interface OpenAiSdkAdapterConfig {
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly clientFactory?: (args: {
    readonly apiKey: string;
    readonly baseURL?: string;
  }) => OpenAiClientLike;
}

function resolveApiKey(config: OpenAiSdkAdapterConfig): string | undefined {
  const keyEnv = config.apiKeyEnv ?? DEFAULT_OPENAI_API_KEY_ENV;
  const value = process.env[keyEnv];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractOpenAiText(response: unknown): string {
  if (!isRecord(response)) {
    return "";
  }

  const outputText = response["output_text"];
  if (typeof outputText === "string") {
    return outputText;
  }

  const output = response["output"];
  if (!Array.isArray(output)) {
    return "";
  }

  const segments: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const content = item["content"];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const entry of content) {
      if (!isRecord(entry)) {
        continue;
      }
      if (entry["type"] !== "output_text") {
        continue;
      }
      const text = entry["text"];
      if (typeof text === "string" && text.length > 0) {
        segments.push(text);
      }
    }
  }

  return segments.join("\n");
}

function defaultClientFactory(args: { readonly apiKey: string; readonly baseURL?: string }): OpenAiClientLike {
  return new OpenAI({
    apiKey: args.apiKey,
    ...(args.baseURL === undefined ? {} : { baseURL: args.baseURL }),
  }) as unknown as OpenAiClientLike;
}

export class OpenAiSdkAdapter implements NodeAdapter {
  readonly #config: OpenAiSdkAdapterConfig;

  constructor(config: OpenAiSdkAdapterConfig = {}) {
    this.#config = config;
  }

  async execute(input: AdapterExecutionInput, context: AdapterExecutionContext): Promise<AdapterExecutionOutput> {
    const apiKey = resolveApiKey(this.#config);
    if (apiKey === undefined) {
      throw new AdapterExecutionError("policy_blocked", "missing OpenAI API key");
    }

    const clientFactory = this.#config.clientFactory ?? defaultClientFactory;
    const client = clientFactory({
      apiKey,
      ...(this.#config.baseUrl === undefined ? {} : { baseURL: this.#config.baseUrl }),
    });
    const maxAttempts = Math.max(1, this.#config.maxAttempts ?? DEFAULT_OPENAI_MAX_ATTEMPTS);
    const retryDelayMs = Math.max(0, this.#config.retryDelayMs ?? DEFAULT_OPENAI_RETRY_DELAY_MS);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await client.responses.create({
          model: input.node.model,
          input: input.promptText,
        }, {
          signal: context.signal,
        });

        const text = extractOpenAiText(response);
        const payload =
          input.output === undefined
            ? {
                text,
                response: isRecord(response) ? response : {},
              }
            : parseJsonObjectCandidate(text, "official OpenAI SDK response");
        return {
          provider: "official-openai-sdk",
          model: input.node.model,
          promptText: input.promptText,
          completionPassed: true,
          when: { always: true },
          payload,
        };
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new AdapterExecutionError("timeout", "official OpenAI SDK request aborted");
        }
        if (context.signal.aborted) {
          throw new AdapterExecutionError("timeout", "official OpenAI SDK request aborted");
        }

        const normalized =
          error instanceof AdapterExecutionError
            ? error
            : new AdapterExecutionError(
                "provider_error",
                error instanceof Error ? error.message : "unknown OpenAI SDK failure",
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

    throw new AdapterExecutionError("provider_error", "official OpenAI SDK adapter exhausted retries");
  }
}
