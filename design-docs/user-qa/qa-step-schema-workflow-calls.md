# Step Schema Cross-Workflow Invocation

**Status**: Resolved

**Created**: 2026-04-24

**Category**: Workflow Schema

## Question

Should cross-workflow invocation remain part of the target authored schema as `workflowCalls`, or should it be replaced by a new step-addressed mechanism?

## Context

The updated design set makes `steps` the canonical execution addresses and removes older branch/loop/sub-workflow authoring from the primary schema.

However, the docs still diverge on cross-workflow invocation:

- `design-docs/specs/design-workflow-json.md` currently omits `workflowCalls` from the target schema
- `design-docs/specs/architecture.md` still describes today's runtime `workflowCalls` behavior as the active cross-workflow path

That ambiguity affects:

- the authoritative `workflow.json` schema
- manager prompt/tool guidance
- GraphQL and CLI control surfaces
- how result delivery is modeled in a step-addressed workflow

## Decision

Resolved on 2026-04-24:

- do not keep a dedicated top-level `workflowCalls` section in the target schema
- treat cross-workflow invocation as the same runtime primitive as ordinary step/node calls
- calling a workflow means calling its callable entry step, normally the manager step
- worker-step calls and workflow-manager calls therefore share one execution-address model and one validation path
- if the current implementation differs, compatibility `workflowCalls` should be lowered into the same call abstraction rather than maintained as a distinct long-term orchestration path

## Resulting Direction

- `workflowCalls[]` is not part of the target authored schema
- cross-workflow routing should use the same `(workflowId, stepId)` execution-address contract as local step calls
- the callee workflow's callable entry step is normally `managerStepId`, or `entryStepId` when the workflow is worker-only
- result handling should follow the same runtime-owned output and mailbox/publication path as any other call-step invocation
- migration work should prefer abstraction unification over parallel feature-specific implementations
