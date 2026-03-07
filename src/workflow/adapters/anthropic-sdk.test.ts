import { describe, expect, test } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionInput } from "../adapter";
import { AnthropicSdkAdapter } from "./anthropic-sdk";

const baseInput: AdapterExecutionInput = {
  workflowId: "wf",
  nodeId: "node-1",
  node: {
    id: "node-1",
    model: "claude-sonnet-4-5",
    executionBackend: "official/anthropic-sdk",
    promptTemplate: "test",
    variables: {},
  },
  mergedVariables: {},
  promptText: "hello",
  arguments: null,
  executionIndex: 1,
};

const baseContext: AdapterExecutionContext = {
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

describe("AnthropicSdkAdapter", () => {
  test("normalizes successful SDK output", async () => {
    let capturedSignal: AbortSignal | undefined;
    const adapter = new AnthropicSdkAdapter({
      clientFactory: () => ({
        messages: {
          async create(_request, options) {
            capturedSignal = options?.signal;
            return {
              content: [{ type: "text", text: "hello from anthropic" }],
            };
          },
        },
      }),
    });
    process.env["ANTHROPIC_API_KEY"] = "test-key";

    const output = await adapter.execute(baseInput, baseContext);
    expect(output.provider).toBe("official-anthropic-sdk");
    expect(output.model).toBe("claude-sonnet-4-5");
    expect(output.payload["text"]).toBe("hello from anthropic");
    expect(capturedSignal).toBe(baseContext.signal);
  });
});
