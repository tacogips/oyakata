import { afterEach, describe, expect, test, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionInput } from "../adapter";
import { ClaudeCodeAgentAdapter } from "./claude";

const originalFetch = globalThis.fetch;

const baseInput: AdapterExecutionInput = {
  workflowId: "wf",
  nodeId: "node-1",
  node: {
    id: "node-1",
    model: "tacogips/claude-code-agent",
    promptTemplate: "test",
    variables: {},
  },
  mergedVariables: {},
  promptText: "hello",
  arguments: { key: "value" },
  executionIndex: 1,
};

const baseContext: AdapterExecutionContext = {
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

describe("ClaudeCodeAgentAdapter", () => {
  test("normalizes successful provider response", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn(async () => {
        return new Response(
          JSON.stringify({
            provider: "claude-provider",
            promptText: "hello",
            completionPassed: true,
            when: { always: true },
            payload: { ok: true },
          }),
          { status: 200 },
        );
      })
      .mockName("fetch-claude-ok") as unknown as typeof fetch;

    const adapter = new ClaudeCodeAgentAdapter({ endpoint: "http://localhost/claude" });
    const output = await adapter.execute(baseInput, baseContext);
    expect(output.provider).toBe("claude-provider");
    expect(output.model).toBe("tacogips/claude-code-agent");
  });

  test("maps invalid response body to invalid_output", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn(async () => {
        return new Response(JSON.stringify({ provider: "claude-provider" }), { status: 200 });
      })
      .mockName("fetch-claude-invalid") as unknown as typeof fetch;

    const adapter = new ClaudeCodeAgentAdapter({ endpoint: "http://localhost/claude" });
    await expect(adapter.execute(baseInput, baseContext)).rejects.toHaveProperty("code", "invalid_output");
  });

  test("retries transient provider failures with bounded attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => new Response("temporary failure", { status: 500 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              provider: "claude-provider",
              promptText: "hello",
              completionPassed: true,
              when: { always: true },
              payload: { ok: true },
            }),
            { status: 200 },
          ),
      );
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const adapter = new ClaudeCodeAgentAdapter({
      endpoint: "http://localhost/claude",
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    const result = await adapter.execute(baseInput, baseContext);
    expect(result.provider).toBe("claude-provider");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
