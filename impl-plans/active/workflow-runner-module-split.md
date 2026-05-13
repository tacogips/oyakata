# Workflow Runner Module Split Implementation Plan

**Status**: Ready
**Design Reference**: `design-docs/specs/architecture.md#workflow-runner-module-split`
**Created**: 2026-05-13
**Last Updated**: 2026-05-13

## Design Document Reference

This plan implements the accepted architecture update for splitting
`src/workflow/engine/workflow-runner-lifecycle.ts`, the remaining oversized
workflow engine source file, into responsibility-named TypeScript modules under
`src/workflow/engine/`.

Scope includes only local semantic extraction needed to make Biome
`lint/nursery/noExcessiveLinesPerFile` pass without suppressions. The public
facade `src/workflow/engine.ts`, the internal runner facade
`src/workflow/engine/workflow-runner.ts`, and the public runner entrypoint
`src/workflow/engine/auto-improve-and-runner.ts` must keep their existing
behavior.

Out of scope:

- changing workflow runtime behavior, queue semantics, retry behavior, manager
  control semantics, or external output publication behavior
- creating ordinal files such as `part-01.ts`
- adding `biome-ignore` comments or disabling `noExcessiveLinesPerFile`
- reconstructing modules through source strings, `eval`, `Function`, or
  `globalThis.Function`
- reverting unrelated dirty working-tree changes

## Codex Reference Mapping

No Codex-reference repository, issue URL, issue repository, or issue number was
provided. Step 1 attempted the preferred local root `../../codex-agent`, but it
was unavailable. This plan therefore traces to the workflow input, local design
documents, and local source paths only.

There are no intentional divergences from Codex-reference behavior because no
reference behavior was available for comparison.

## Modules

### 1. Runner Orchestration Shell

#### `src/workflow/engine/workflow-runner-lifecycle.ts`

**Status**: COMPLETED

```typescript
export async function runWorkflowInternal(
  workflowName: string,
  options: NormalizedWorkflowRunOptions,
  adapter?: NodeAdapter,
  guards?: EngineExecutionGuards,
  crossWorkflowInvocationStack?: readonly string[],
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>>;
```

**Checklist**:

- [ ] Keep only queue-loop sequencing and phase orchestration in this file.
- [ ] Delegate setup, session entry, step input, node execution, and
      finalization to typed helpers.
- [ ] Keep the file below 1000 lines.

### 2. Shared Runner Context

#### `src/workflow/engine/workflow-runner-context.ts`

**Status**: NOT_STARTED

```typescript
interface WorkflowRunnerBaseContext {
  workflowName: string;
  options: NormalizedWorkflowRunOptions;
  adapter?: NodeAdapter;
  guards?: EngineExecutionGuards;
  crossWorkflowInvocationStack: readonly string[];
}

interface WorkflowRunnerLoadedContext extends WorkflowRunnerBaseContext {
  workflowWorkingDirectory: string;
  loaded: LoadedWorkflow;
  workflow: WorkflowJson;
}
```

**Checklist**:

- [ ] Define only the context records needed by at least two extracted modules.
- [ ] Keep mutable state explicit on context objects.
- [ ] Avoid circular imports by keeping runtime helper functions in their
      responsibility modules.

### 3. Run Setup

#### `src/workflow/engine/run-setup.ts`

**Status**: NOT_STARTED

```typescript
interface PrepareWorkflowRunInput {
  workflowName: string;
  options: NormalizedWorkflowRunOptions;
  adapter?: NodeAdapter;
  guards?: EngineExecutionGuards;
  crossWorkflowInvocationStack: readonly string[];
}

async function prepareWorkflowRun(
  input: PrepareWorkflowRunInput,
): Promise<Result<WorkflowRunSetupContext, WorkflowRunFailure>>;
```

**Checklist**:

- [ ] Move working-directory resolution and mutually exclusive entry-mode
      validation.
- [ ] Move source-session preload for resume, rerun, and continuation.
- [ ] Move workflow loading, auto-improve execution-copy reload, runtime
      readiness checks, adapter selection, cancellation probe setup, manager
      session store creation, and static workflow maps.
- [ ] Keep this file below 1000 lines.

### 4. Session Entry

#### `src/workflow/engine/session-entry.ts`

**Status**: NOT_STARTED

```typescript
interface EnterWorkflowSessionInput {
  setup: WorkflowRunSetupContext;
}

async function enterWorkflowSession(
  input: EnterWorkflowSessionInput,
): Promise<Result<WorkflowSessionEntryContext, WorkflowRunFailure>>;
```

**Checklist**:

- [ ] Move fresh-run, resume, rerun, and history-linked continuation setup.
- [ ] Move auto-improve supervision state attachment and bootstrap human input
      communication.
- [ ] Move nested superviser handoff and early paused/completed returns.
- [ ] Keep this file below 1000 lines.

### 5. Step Input

#### `src/workflow/engine/step-input.ts`

**Status**: NOT_STARTED

```typescript
interface PrepareStepInput {
  runner: WorkflowRunnerLoopContext;
  session: WorkflowSessionState;
  stepId: string;
}

async function prepareStepExecution(
  input: PrepareStepInput,
): Promise<Result<PreparedStepExecution, WorkflowRunFailure>>;
```

**Checklist**:

- [ ] Move missing-step failure handling and optional-step decision gating.
- [ ] Move scenario/dry-run payload resolution, execution id allocation, and
      artifact directory setup.
- [ ] Move workflow-run event emission, upstream/latest-output mailbox input
      resolution, prompt/input assembly, and candidate path preparation.
- [ ] Keep this file below 1000 lines.

### 6. Node Execution

#### `src/workflow/engine/node-execution.ts`

**Status**: NOT_STARTED

```typescript
interface ExecutePreparedStepInput {
  runner: WorkflowRunnerLoopContext;
  prepared: PreparedStepExecution;
}

async function executePreparedStep(
  input: ExecutePreparedStepInput,
): Promise<Result<NodeExecutionPhaseResult, WorkflowRunFailure>>;
```

**Checklist**:

- [ ] Move user-action pause handling and optional skip execution.
- [ ] Move agent/native execution, manager control-plane environment setup,
      timeout and stall policy, output-contract candidate attempts, schema
      validation, process/LLM log capture, backend session persistence, and
      execution-log normalization.
- [ ] Keep this file below 1000 lines.

### 7. Result Finalization

#### `src/workflow/engine/result-finalization.ts`

**Status**: PARTIAL

```typescript
interface FinalizeStepResultInput {
  runner: WorkflowRunnerLoopContext;
  phaseResult: NodeExecutionPhaseResult;
}

async function finalizeStepResult(
  input: FinalizeStepResultInput,
): Promise<Result<WorkflowRunnerTransitionResult, WorkflowRunFailure>>;
```

**Checklist**:

- [ ] Keep existing `finalizeCompletedWorkflowRun()` behavior intact.
- [ ] Move input/output/meta/handoff artifact writing and runtime DB
      persistence.
- [ ] Move manager session finalization, optional manager decisions,
      completion-rule evaluation, communication consumption, edge/loop
      transition selection, local fanout dispatch, cross-workflow dispatch,
      retry queue updates, workflow output runtime-variable updates, terminal
      failure mapping, and final external output publication.
- [ ] Keep this file below 1000 lines.

## Module Status

| Module | File Path | Status | Tests |
| --- | --- | --- | --- |
| Orchestration shell | `src/workflow/engine/workflow-runner-lifecycle.ts` | NOT_STARTED | Targeted workflow engine tests |
| Shared context | `src/workflow/engine/workflow-runner-context.ts` | NOT_STARTED | Typecheck and targeted workflow engine tests |
| Run setup | `src/workflow/engine/run-setup.ts` | NOT_STARTED | Targeted workflow engine tests |
| Session entry | `src/workflow/engine/session-entry.ts` | NOT_STARTED | Resume/rerun/continuation tests |
| Step input | `src/workflow/engine/step-input.ts` | NOT_STARTED | Call-step and mailbox-adjacent tests |
| Node execution | `src/workflow/engine/node-execution.ts` | NOT_STARTED | Call-step implementation and manager-control tests |
| Result finalization | `src/workflow/engine/result-finalization.ts` | PARTIAL | Workflow completion, fanout, and supervisor tests |

## Task Breakdown

### TASK-001: Baseline Inspection And Rejected Pattern Guard

**Status**: NOT_STARTED
**Parallelizable**: No
**Deliverables**:

- Record current line counts for `src/workflow/engine/*.ts`.
- Confirm no dynamic source reconstruction is present or introduced.
- Identify existing extracted stubs and partial finalization helper boundaries.

**Completion Criteria**:

- [x] `find src/workflow/engine -maxdepth 1 -type f -name '*.ts' -print | sort | xargs wc -l | sort -nr` is recorded in the progress log.
- [x] `rg "globalThis\\.Function|WORKFLOW_RUNNER_.*_SOURCE|eval\\(|Function\\(" src/workflow/engine` returns no implementation blockers.

### TASK-002: Extract Run Setup

**Status**: NOT_STARTED
**Parallelizable**: No
**Depends On**: TASK-001
**Deliverables**:

- `src/workflow/engine/workflow-runner-context.ts`
- `src/workflow/engine/run-setup.ts`
- smaller `src/workflow/engine/workflow-runner-lifecycle.ts`

**Completion Criteria**:

- [ ] Setup helper returns typed success/failure instead of throwing for normal
      run setup failures.
- [ ] `runWorkflowInternal()` delegates setup without changing error messages.
- [ ] No touched source file exceeds 1000 lines.

### TASK-003: Extract Session Entry

**Status**: NOT_STARTED
**Parallelizable**: No
**Depends On**: TASK-002
**Deliverables**:

- `src/workflow/engine/session-entry.ts`
- smaller `src/workflow/engine/workflow-runner-lifecycle.ts`

**Completion Criteria**:

- [ ] Fresh, resume, rerun, and continuation entry paths preserve session
      status and queue behavior.
- [ ] Auto-improve and nested superviser entry handling remain behaviorally
      identical.
- [ ] No touched source file exceeds 1000 lines.

### TASK-004: Extract Step Input

**Status**: NOT_STARTED
**Parallelizable**: No
**Depends On**: TASK-003
**Deliverables**:

- `src/workflow/engine/step-input.ts`
- smaller `src/workflow/engine/workflow-runner-lifecycle.ts`

**Completion Criteria**:

- [ ] Prepared step records contain all fields needed for execution and
      finalization.
- [ ] Mailbox input, prompt assembly, candidate path, and scenario/dry-run
      semantics match the pre-split behavior.
- [ ] No touched source file exceeds 1000 lines.

### TASK-005: Extract Node Execution

**Status**: NOT_STARTED
**Parallelizable**: No
**Depends On**: TASK-004
**Deliverables**:

- `src/workflow/engine/node-execution.ts`
- smaller `src/workflow/engine/workflow-runner-lifecycle.ts`

**Completion Criteria**:

- [ ] Agent and native node execution paths preserve timeout, stall, log,
      candidate-output, and backend-session behavior.
- [ ] Optional skip and user-action pause behavior remain unchanged.
- [ ] No touched source file exceeds 1000 lines.

### TASK-006: Extract Result Finalization And Transitions

**Status**: NOT_STARTED
**Parallelizable**: No
**Depends On**: TASK-005
**Deliverables**:

- expanded `src/workflow/engine/result-finalization.ts`
- smaller `src/workflow/engine/workflow-runner-lifecycle.ts`

**Completion Criteria**:

- [ ] Artifact writes, runtime DB persistence, manager decisions,
      communication consumption, completion evaluation, edge/loop transition,
      fanout, cross-workflow dispatch, retry, runtime-variable, terminal
      failure, and external-output publication paths preserve behavior.
- [ ] No touched source file exceeds 1000 lines.

### TASK-007: Import Surface And Verification Closure

**Status**: NOT_STARTED
**Parallelizable**: No
**Depends On**: TASK-006
**Deliverables**:

- stable exports through `src/workflow/engine.ts`,
  `src/workflow/engine/workflow-runner.ts`, and
  `src/workflow/engine/auto-improve-and-runner.ts`
- documentation check for README and exposed workflow skill references if any
  public file path, module responsibility, or workflow instruction becomes
  stale after extraction
- progress-log update with verification results

**Completion Criteria**:

- [ ] `bun run format` passes.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint:biome` passes with no `noExcessiveLinesPerFile` errors.
- [ ] Targeted workflow tests pass.
- [ ] Line-count and rejected-pattern checks pass.
- [ ] Documentation changes are either unnecessary because no public reference
      became stale, or are completed in the later user-facing documentation
      refresh step.

## Dependencies

| Task | Depends On | Status |
| --- | --- | --- |
| TASK-001 | None | COMPLETED |
| TASK-002 | TASK-001 | READY |
| TASK-003 | TASK-002 | BLOCKED |
| TASK-004 | TASK-003 | BLOCKED |
| TASK-005 | TASK-004 | BLOCKED |
| TASK-006 | TASK-005 | BLOCKED |
| TASK-007 | TASK-006 | BLOCKED |

No tasks are marked parallelizable. Although files have distinct target
responsibilities, each extraction changes the same orchestration shell and
shared context shape, so the write scopes are not disjoint.

## Verification Plan

Run these commands before closing the implementation:

```bash
bun run format
bun run typecheck
bun run lint:biome
bun test src/workflow/engine.test.ts src/workflow/call-step.test.ts src/workflow/call-step-impl-execution.test.ts src/workflow/call-step-impl-failures.test.ts src/workflow/history-continuation.test.ts src/workflow/manager-control.test.ts src/workflow/manager-message-service.test.ts src/workflow/manager-session-store.test.ts src/workflow/superviser.test.ts src/workflow/auto-improve-policy.test.ts src/workflow/supervisor-runner-pool.test.ts
find src -name '*.ts' -not -name '*.test.ts' -print | xargs wc -l | sort -nr | sed -n '1,40p'
rg "globalThis\\.Function|WORKFLOW_RUNNER_.*_SOURCE|eval\\(|part-[0-9]+|biome-ignore.*noExcessiveLinesPerFile|noExcessiveLinesPerFile" src/workflow/engine design-docs/specs/architecture.md impl-plans/active/workflow-runner-module-split.md
```

The final `rg` command is expected to show only legitimate design/plan
references to `noExcessiveLinesPerFile`; it must not show implementation
suppression comments, disabled lint rules, source-string reconstruction, or
ordinal split filenames.

## Completion Criteria

- [ ] `src/workflow/engine/workflow-runner-lifecycle.ts` is below 1000 lines.
- [ ] Every non-test TypeScript source file under `src` is below 1000 lines.
- [ ] Responsibility-named modules own setup, session entry, step input, node
      execution, and result finalization behavior.
- [ ] Public facade imports remain stable.
- [ ] No Biome suppressions or lint-rule disabling are added.
- [ ] No source-string, `eval`, `Function`, or `globalThis.Function` runner
      reconstruction exists.
- [ ] README and exposed workflow skill references are checked for stale public
      paths or instructions after the split.
- [ ] Required verification commands pass or any failure is documented with a
      concrete blocker.

## Addressed Review Feedback

- Step 3 design review accepted the design with low feedback.
- This plan explicitly includes `bun run format`, `bun run typecheck`, and
  `bun run lint:biome` as required verification commands.
- This plan keeps implementation scoped to
  `src/workflow/engine/workflow-runner-lifecycle.ts` semantic extraction under
  `src/workflow/engine/` while preserving facade behavior.
- No Step 5 implementation-plan review feedback exists for this execution.

## Progress Log

### Session: 2026-05-13

**Tasks Completed**: Planning only.
**Tasks In Progress**: None.
**Blockers**: None for implementation planning.
**Notes**: Replaced the prior recovery note with an actionable Step 4
implementation plan tied to the accepted architecture design and Step 3 review
feedback. Later implementation sessions must update task statuses, completion
criteria, line-count results, and verification outcomes here before handoff.

### Session: 2026-05-13 Step 6 implementation baseline

**Tasks Completed**: TASK-001.
**Tasks In Progress**: None.
**Blockers**: The semantic extraction tasks remain to be implemented; Biome
still fails on `src/workflow/engine/workflow-runner-lifecycle.ts` at 3192
lines.
**Notes**: Recorded the current engine line-count baseline:

```text
  6860 total
  3192 src/workflow/engine/workflow-runner-lifecycle.ts
   767 src/workflow/engine/fanout-dispatch.ts
   736 src/workflow/engine/cross-workflow-dispatch.ts
   707 src/workflow/engine/mailbox-communication-artifacts.ts
   663 src/workflow/engine/types-and-session-state.ts
   634 src/workflow/engine/auto-improve-and-runner.ts
   146 src/workflow/engine/result-finalization.ts
     3 src/workflow/engine/step-input.ts
     3 src/workflow/engine/session-entry.ts
     3 src/workflow/engine/run-setup.ts
     3 src/workflow/engine/node-execution.ts
     2 src/workflow/engine/mailbox-and-communications.ts
     1 src/workflow/engine/workflow-runner.ts
```

The rejected-pattern scan found no implementation blockers in
`src/workflow/engine`; matches were limited to design/plan references for the
guardrail text. `bun run lint:biome` was run and failed only with
`lint/nursery/noExcessiveLinesPerFile` for
`src/workflow/engine/workflow-runner-lifecycle.ts`.
