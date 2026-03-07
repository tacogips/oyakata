import { describe, expect, test } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionInput } from "../adapter";
import { OpenAiSdkAdapter } from "./openai-sdk";

const baseInput: AdapterExecutionInput = {
  workflowId: "wf",
  nodeId: "node-1",
  node: {
    id: "node-1",
    model: "gpt-5",
    executionBackend: "official/openai-sdk",
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

describe("OpenAiSdkAdapter", () => {
  test("normalizes successful SDK output", async () => {
    const adapter = new OpenAiSdkAdapter({
      clientFactory: () => ({
        responses: {
          async create() {
            return {
              output_text: "hello from openai",
            };
          },
        },
      }),
    });
    process.env["OPENAI_API_KEY"] = "test-key";

    const output = await adapter.execute(baseInput, baseContext);
    expect(output.provider).toBe("official-openai-sdk");
    expect(output.model).toBe("gpt-5");
    expect(output.payload["text"]).toBe("hello from openai");
  });
});
