import type { NodePayload } from "./types";

export type AdapterFailureCode =
  | "provider_error"
  | "timeout"
  | "invalid_output"
  | "policy_blocked";

export interface AdapterExecutionContext {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface AdapterExecutionInput {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly node: NodePayload;
  readonly mergedVariables: Readonly<Record<string, unknown>>;
  readonly promptText: string;
  readonly arguments: Readonly<Record<string, unknown>> | null;
  readonly executionIndex: number;
}

export interface AdapterExecutionOutput {
  readonly provider: string;
  readonly model: string;
  readonly promptText: string;
  readonly completionPassed: boolean;
  readonly when: Readonly<Record<string, boolean>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class AdapterExecutionError extends Error {
  readonly code: AdapterFailureCode;

  constructor(code: AdapterFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

function isBooleanMap(value: unknown): value is Readonly<Record<string, boolean>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "boolean");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAdapterOutput(
  value: unknown,
  fallbackModel: string,
): AdapterExecutionOutput {
  if (!isRecord(value)) {
    throw new AdapterExecutionError("invalid_output", "adapter output must be an object");
  }

  const provider = value["provider"];
  const model = value["model"];
  const promptText = value["promptText"];
  const completionPassed = value["completionPassed"];
  const when = value["when"];
  const payload = value["payload"];

  if (typeof provider !== "string" || provider.length === 0) {
    throw new AdapterExecutionError("invalid_output", "adapter output.provider must be a non-empty string");
  }
  if (typeof promptText !== "string") {
    throw new AdapterExecutionError("invalid_output", "adapter output.promptText must be a string");
  }
  if (typeof completionPassed !== "boolean") {
    throw new AdapterExecutionError("invalid_output", "adapter output.completionPassed must be a boolean");
  }
  if (!isBooleanMap(when)) {
    throw new AdapterExecutionError("invalid_output", "adapter output.when must be an object<boolean>");
  }
  if (!isRecord(payload)) {
    throw new AdapterExecutionError("invalid_output", "adapter output.payload must be an object");
  }

  return {
    provider,
    model: typeof model === "string" && model.length > 0 ? model : fallbackModel,
    promptText,
    completionPassed,
    when,
    payload,
  };
}

export interface NodeAdapter {
  execute(input: AdapterExecutionInput, context: AdapterExecutionContext): Promise<AdapterExecutionOutput>;
}

export interface MockNodeResponse {
  readonly provider?: string;
  readonly model?: string;
  readonly promptText?: string;
  readonly completionPassed?: boolean;
  readonly when?: Readonly<Record<string, boolean>>;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly fail?: boolean;
}

export type MockNodeScenarioEntry = MockNodeResponse | readonly MockNodeResponse[];
export type MockNodeScenario = Readonly<Record<string, MockNodeScenarioEntry>>;

function resolveScenarioEntry(entry: MockNodeScenarioEntry, executionIndex: number): MockNodeResponse {
  if (Array.isArray(entry)) {
    if (entry.length === 0) {
      return {};
    }
    const selected = entry[Math.min(executionIndex - 1, entry.length - 1)];
    return selected ?? {};
  }
  return entry as MockNodeResponse;
}

export class DeterministicNodeAdapter implements NodeAdapter {
  async execute(input: AdapterExecutionInput, _context: AdapterExecutionContext): Promise<AdapterExecutionOutput> {
    return {
      provider: "deterministic-local",
      model: input.node.model,
      promptText: input.promptText,
      completionPassed: true,
      when: { always: true },
      payload: {
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        renderedLength: input.promptText.length,
      },
    };
  }
}

export class ScenarioNodeAdapter implements NodeAdapter {
  readonly #fallback: NodeAdapter;
  readonly #scenario: MockNodeScenario;

  constructor(scenario: MockNodeScenario, fallback: NodeAdapter = new DeterministicNodeAdapter()) {
    this.#scenario = scenario;
    this.#fallback = fallback;
  }

  async execute(input: AdapterExecutionInput, context: AdapterExecutionContext): Promise<AdapterExecutionOutput> {
    const scenarioEntry = this.#scenario[input.nodeId];
    if (scenarioEntry === undefined) {
      return this.#fallback.execute(input, context);
    }

    const response = resolveScenarioEntry(scenarioEntry, input.executionIndex);
    if (response.fail === true) {
      throw new Error(`scenario forced failure for node '${input.nodeId}'`);
    }

    return {
      provider: response.provider ?? "scenario-mock",
      model: response.model ?? input.node.model,
      promptText: response.promptText ?? input.promptText,
      completionPassed: response.completionPassed ?? true,
      when: response.when ?? { always: true },
      payload: response.payload ?? {},
    };
  }
}
