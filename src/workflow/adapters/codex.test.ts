import { afterEach, describe, expect, test, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionInput } from "../adapter";
import { CodexAgentAdapter } from "./codex";

const originalFetch = globalThis.fetch;

const baseInput: AdapterExecutionInput = {
  workflowId: "wf",
  workflowExecutionId: "sess-1",
  nodeId: "node-1",
  nodeExecId: "exec-1",
  node: {
    id: "node-1",
    model: "tacogips/codex-agent",
    promptTemplate: "test",
    variables: {},
  },
  mergedVariables: {},
  promptText: "hello",
  arguments: { key: "value" },
  executionIndex: 1,
  artifactDir: "/tmp/node-1/exec-1",
  upstreamCommunicationIds: ["comm-1"],
};

const baseContext: AdapterExecutionContext = {
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  delete process.env["TEST_CODEX_KEY"];
});

describe("CodexAgentAdapter", () => {
  test("calls provider endpoint and normalizes output", async () => {
    process.env["TEST_CODEX_KEY"] = "secret";
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          provider: "codex-provider",
          model: "tacogips/codex-agent",
          promptText: "hello",
          completionPassed: true,
          when: { always: true },
          payload: { ok: true },
        }),
        { status: 200 },
      );
    });
    // explicit reassignment keeps compatibility with this vitest version
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const adapter = new CodexAgentAdapter({
      endpoint: "http://localhost/codex",
      apiKeyEnv: "TEST_CODEX_KEY",
    });

    const output = await adapter.execute(baseInput, baseContext);
    expect(output.provider).toBe("codex-provider");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = (fetchMock as { mock: { calls: unknown[][] } }).mock.calls;
    const request = calls[0]?.[1] as RequestInit | undefined;
    const headers = (request?.headers ?? {}) as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer secret");
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    expect(body["workflowExecutionId"]).toBe("sess-1");
    expect(body["nodeExecId"]).toBe("exec-1");
    expect(body["artifactDir"]).toBe("/tmp/node-1/exec-1");
  });

  test("maps blocked responses to policy_blocked", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = vi
      .fn(async () => {
        return new Response("blocked", { status: 403 });
      })
      .mockName("fetch-blocked") as unknown as typeof fetch;

    const adapter = new CodexAgentAdapter({ endpoint: "http://localhost/codex" });
    await expect(adapter.execute(baseInput, baseContext)).rejects.toHaveProperty("code", "policy_blocked");
  });

  test("omits artifactDir from contract-enabled requests", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          provider: "codex-provider",
          model: "tacogips/codex-agent",
          promptText: "hello",
          completionPassed: true,
          when: { always: true },
          payload: { ok: true },
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const adapter = new CodexAgentAdapter({ endpoint: "http://localhost/codex" });
    await adapter.execute(
      {
        ...baseInput,
        output: {
          maxValidationAttempts: 2,
          attempt: 1,
          candidatePath: "/tmp/candidate.json",
          validationErrors: [],
          publication: {
            owner: "runtime",
            finalArtifactWrite: "runtime-only",
            mailboxWrite: "runtime-only-after-validation",
            candidateSubmission: "inline-json-or-reserved-candidate-file",
            futureCommunicationIdsExposed: false,
          },
        },
      },
      baseContext,
    );

    const calls = (fetchMock as { mock: { calls: unknown[][] } }).mock.calls;
    const request = calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    expect(body["artifactDir"]).toBeUndefined();
    expect(body["output"]).toBeDefined();
  });

  test("retries transient provider failures with bounded attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => new Response("temporary failure", { status: 500 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              provider: "codex-provider",
              model: "tacogips/codex-agent",
              promptText: "hello",
              completionPassed: true,
              when: { always: true },
              payload: { ok: true },
            }),
            { status: 200 },
          ),
      );
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const adapter = new CodexAgentAdapter({
      endpoint: "http://localhost/codex",
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    const result = await adapter.execute(baseInput, baseContext);
    expect(result.provider).toBe("codex-provider");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
