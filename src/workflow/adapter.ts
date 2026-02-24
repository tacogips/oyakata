import { renderPromptTemplate } from "./render";
import type { NodePayload } from "./types";

export interface AdapterExecutionInput {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly node: NodePayload;
  readonly mergedVariables: Readonly<Record<string, unknown>>;
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
