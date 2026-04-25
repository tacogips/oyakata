import type { WorkflowCallRef, WorkflowJson, WorkflowStepRef } from "./types";

/**
 * When set, cross-workflow dispatch is **only** from `steps[].transitions` (see
 * {@link crossWorkflowCallsFromSteps}). Explicit `workflow.workflowCalls` is ignored
 * (validated step-addressed bundles omit it; see `impl-plans/workflow-legacy-compatibility-removal.md`).
 */
function isStepAddressedCrossWorkflowDispatch(
  workflow: Pick<WorkflowJson, "entryStepId" | "steps">,
): boolean {
  return (
    workflow.entryStepId !== undefined &&
    workflow.steps !== undefined &&
    workflow.steps.length > 0
  );
}

/**
 * Cross-workflow step transitions are authored on `steps[].transitions` and executed
 * like workflow calls with deterministic ids `__cw:<callerStepId>`. They are not
 * merged onto `workflow.workflowCalls` during normalization so the bundle stays
 * authored-shape clean; runtime and readiness inspection derive this list instead.
 */
export function crossWorkflowCallsFromSteps(
  steps: readonly WorkflowStepRef[] | undefined,
): readonly WorkflowCallRef[] {
  if (steps === undefined) {
    return [];
  }
  const out: WorkflowCallRef[] = [];
  for (const step of steps) {
    // Step-addressed validation allows at most one `toWorkflowId` transition per step.
    const cross = step.transitions?.find((t) => t.toWorkflowId !== undefined);
    if (
      cross === undefined ||
      cross.toWorkflowId === undefined ||
      cross.resumeStepId === undefined
    ) {
      continue;
    }
    const when = cross.label === undefined ? undefined : cross.label;
    out.push({
      id: `__cw:${step.id}`,
      workflowId: cross.toWorkflowId,
      callerNodeId: step.id,
      callerStepId: step.id,
      resultNodeId: cross.resumeStepId,
      ...(when === undefined ? {} : { when }),
    });
  }
  return out;
}

/**
 * For step-addressed normalized workflows (`entryStepId` + `steps[]`), returns only
 * step-derived cross-workflow calls. Otherwise, unions explicit `workflowCalls`
 * with step-derived rows; explicit ids win on id collision. Iteration order
 * follows Map insertion (derived, then explicit-only) in the legacy union path.
 * Workflow-call **execution** uses {@link workflowCallsForExecutionMatch} instead.
 */
export function effectiveWorkflowCalls(
  workflow: Pick<
    WorkflowJson,
    "workflowCalls" | "steps" | "entryStepId"
  >,
): readonly WorkflowCallRef[] {
  if (isStepAddressedCrossWorkflowDispatch(workflow)) {
    return crossWorkflowCallsFromSteps(workflow.steps);
  }
  const explicit = workflow.workflowCalls ?? [];
  const derived = crossWorkflowCallsFromSteps(workflow.steps);
  const byId = new Map<string, WorkflowCallRef>();
  for (const d of derived) {
    byId.set(d.id, d);
  }
  for (const e of explicit) {
    byId.set(e.id, e);
  }
  return [...byId.values()];
}

/**
 * Workflow-call rows to execute for the current caller, in **engine** order: explicit
 * `workflow.workflowCalls` matches preserve their authored array order, then step-derived
 * `__cw:*` rows that match and whose ids are not already taken by an explicit match.
 *
 * Do not implement this by filtering {@link effectiveWorkflowCalls} in the legacy
 * union case: inspection uses a different id merge order (derived first, then
 * explicit-only) for stable summaries.
 */
export function workflowCallsForExecutionMatch(
  workflow: Pick<
    WorkflowJson,
    "workflowCalls" | "steps" | "entryStepId"
  >,
  match: (call: WorkflowCallRef) => boolean,
): readonly WorkflowCallRef[] {
  if (isStepAddressedCrossWorkflowDispatch(workflow)) {
    return crossWorkflowCallsFromSteps(workflow.steps).filter(match);
  }
  const explicitMatches = (workflow.workflowCalls ?? []).filter(match);
  const stepDerivedMatches = crossWorkflowCallsFromSteps(workflow.steps).filter(
    match,
  );
  const seenIds = new Set(explicitMatches.map((c) => c.id));
  return [
    ...explicitMatches,
    ...stepDerivedMatches.filter((c) => !seenIds.has(c.id)),
  ];
}
