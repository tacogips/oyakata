import type { SubWorkflowRef, WorkflowJson, WorkflowVisJson } from "./types";

export interface DerivedVisNode {
  readonly id: string;
  readonly order: number;
  readonly indent: number;
  readonly color: "default" | `loop:${string}` | `group:${string}`;
}

interface ScopeInterval {
  readonly id: string;
  readonly startOrder: number;
  readonly endOrder: number;
}

interface ScopeMetadata {
  readonly groupIntervals: readonly ScopeInterval[];
  readonly loopIntervals: readonly ScopeInterval[];
}

function compareIntervals(a: ScopeInterval, b: ScopeInterval): number {
  const spanA = a.endOrder - a.startOrder;
  const spanB = b.endOrder - b.startOrder;
  return spanA - spanB || a.startOrder - b.startOrder || a.id.localeCompare(b.id);
}

function resolveSubWorkflowInterval(
  subWorkflow: SubWorkflowRef,
  orderByNodeId: ReadonlyMap<string, number>,
): ScopeInterval | null {
  const inputOrder = orderByNodeId.get(subWorkflow.inputNodeId);
  const outputOrder = orderByNodeId.get(subWorkflow.outputNodeId);
  if (inputOrder === undefined || outputOrder === undefined || inputOrder > outputOrder) {
    return null;
  }

  return {
    id: subWorkflow.id,
    startOrder: inputOrder,
    endOrder: outputOrder,
  };
}

function buildScopeMetadata(
  workflow: WorkflowJson,
  orderByNodeId: ReadonlyMap<string, number>,
): ScopeMetadata {
  const groupIntervals = workflow.subWorkflows
    .map((entry) => resolveSubWorkflowInterval(entry, orderByNodeId))
    .filter((entry): entry is ScopeInterval => entry !== null)
    .sort(compareIntervals);

  const loopIntervals = (workflow.loops ?? [])
    .map((loop) => {
      const judgeOrder = orderByNodeId.get(loop.judgeNodeId);
      if (judgeOrder === undefined) {
        return null;
      }
      const continueTargetOrders = workflow.edges
        .filter((edge) => edge.from === loop.judgeNodeId && edge.when === loop.continueWhen)
        .map((edge) => orderByNodeId.get(edge.to))
        .filter((value): value is number => value !== undefined)
        .filter((value) => value <= judgeOrder);
      if (continueTargetOrders.length === 0) {
        return null;
      }
      return {
        id: loop.id,
        startOrder: Math.min(...continueTargetOrders),
        endOrder: judgeOrder,
      } satisfies ScopeInterval;
    })
    .filter((entry): entry is ScopeInterval => entry !== null)
    .sort(compareIntervals);

  return {
    groupIntervals,
    loopIntervals,
  };
}

function collectScopesForOrder(order: number, intervals: readonly ScopeInterval[]): readonly ScopeInterval[] {
  return intervals.filter((entry) => entry.startOrder <= order && order <= entry.endOrder).sort(compareIntervals);
}

export function deriveWorkflowVisualization(args: {
  readonly workflow: WorkflowJson;
  readonly workflowVis: WorkflowVisJson;
}): readonly DerivedVisNode[] {
  const orderedVisNodes = [...args.workflowVis.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const orderByNodeId = new Map<string, number>();
  orderedVisNodes.forEach((node) => {
    orderByNodeId.set(node.id, node.order);
  });
  const scopeMetadata = buildScopeMetadata(args.workflow, orderByNodeId);

  return orderedVisNodes.map((node) => ({
    id: node.id,
    order: node.order,
    indent:
      collectScopesForOrder(node.order, scopeMetadata.groupIntervals).length +
      collectScopesForOrder(node.order, scopeMetadata.loopIntervals).length,
    color: (() => {
      const loopScopes = collectScopesForOrder(node.order, scopeMetadata.loopIntervals);
      if (loopScopes.length > 0) {
        return `loop:${loopScopes[0]?.id ?? ""}` as `loop:${string}`;
      }
      const groupScopes = collectScopesForOrder(node.order, scopeMetadata.groupIntervals);
      if (groupScopes.length > 0) {
        return `group:${groupScopes[0]?.id ?? ""}` as `group:${string}`;
      }
      return "default";
    })(),
  }));
}
