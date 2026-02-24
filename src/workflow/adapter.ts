import { renderPromptTemplate } from "./render";
import type { NodePayload } from "./types";

export interface AdapterExecutionInput {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly node: NodePayload;
  readonly mergedVariables: Readonly<Record<string, unknown>>;
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

export interface NodeAdapter {
  execute(input: AdapterExecutionInput): Promise<AdapterExecutionOutput>;
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
  async execute(input: AdapterExecutionInput): Promise<AdapterExecutionOutput> {
    const promptText = renderPromptTemplate(input.node.promptTemplate, input.mergedVariables);
    return {
      provider: "deterministic-local",
      model: input.node.model,
      promptText,
      completionPassed: true,
      when: { always: true },
      payload: {
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        renderedLength: promptText.length,
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

  async execute(input: AdapterExecutionInput): Promise<AdapterExecutionOutput> {
    const scenarioEntry = this.#scenario[input.nodeId];
    if (scenarioEntry === undefined) {
      return this.#fallback.execute(input);
    }

    const response = resolveScenarioEntry(scenarioEntry, input.executionIndex);
    if (response.fail === true) {
      throw new Error(`scenario forced failure for node '${input.nodeId}'`);
    }

    const promptText = renderPromptTemplate(input.node.promptTemplate, input.mergedVariables);
    return {
      provider: response.provider ?? "scenario-mock",
      model: response.model ?? input.node.model,
      promptText: response.promptText ?? promptText,
      completionPassed: response.completionPassed ?? true,
      when: response.when ?? { always: true },
      payload: response.payload ?? {},
    };
  }
}
