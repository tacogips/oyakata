# Step-addressed Workflow Runtime Cutover Implementation Plan

**Status**: Ready
**Design Reference**: `design-docs/specs/design-workflow-json.md`, `design-docs/specs/design-node-jump-and-code-manager-runtime.md`, `design-docs/specs/design-workflow-steps-and-node-reuse.md`, `design-docs/specs/architecture.md`, `design-docs/specs/command.md`, `design-docs/user-qa/qa-step-schema-workflow-calls.md`
**Created**: 2026-04-24
**Last Updated**: 2026-04-24

## Design Document Reference

**Source**:

- `design-docs/specs/design-workflow-json.md`
- `design-docs/specs/design-node-jump-and-code-manager-runtime.md`
- `design-docs/specs/design-workflow-steps-and-node-reuse.md`
- `design-docs/specs/architecture.md`
- `design-docs/specs/command.md`
- `design-docs/user-qa/qa-step-schema-workflow-calls.md`

### Summary

Replace the current node-ordered transitional workflow model with the new
step-addressed runtime:

- `workflow.json.steps[]` becomes the canonical execution graph
- `workflow.json.nodes[]` becomes a reusable node registry
- routing is driven by step `transitions[]` plus validated output `next.stepId`
- manager execution defaults to deterministic `managerType: "code"`
- repeated visits to one node use distinct mailbox instances and may reuse the
  same backend session with prompt variants
- cross-workflow invocation uses the same `(workflowId, stepId)` execution
  address as local step calls

This plan is intentionally a breaking cutover. Backward compatibility with
`entryNodeId`, `managerNodeId`, `workflowCalls`, `edges`, `loops`,
`subWorkflows`, `subWorkflowConversations`, branch/loop judges, and
`call-node` naming is out of scope.

### Scope

**Included**:

- authored schema cutover to `entryStepId`, optional `managerStepId`, reusable
  node registry entries, and step definitions
- loader/save/validator/json-schema changes that reject removed legacy authored
  fields
- runtime state changes for step ids, mailbox instance ids, prompt variants,
  step-local timeout overrides, and unified `call-step`
- deterministic code-manager decision path for transitions, timeout policy, and
  workflow completion/failure
- cross-workflow dispatch unification so former workflow-level calls lower into
  the same step-call primitive
- CLI/library/GraphQL/TUI inspection and command wording updates from
  node-centric to step-centric language
- example, README, and regression migration to the step-addressed model

**Excluded**:

- `--auto-improve` supervision runtime
- browser/web editor feature work beyond schema/runtime alignment
- preserving compatibility loaders or runtime branches for removed legacy
  workflow fields

## Modules

### 1. Authored Schema and Bundle I/O

#### `src/workflow/types.ts`, `src/workflow/json-schema.ts`, `src/workflow/validate.ts`, `src/workflow/load.ts`, `src/workflow/save.ts`, `src/workflow/inspect.ts`, `src/workflow/create.ts`

**Status**: NOT_STARTED

```typescript
export interface WorkflowTimeoutPolicy {
  readonly onTimeout: "fail" | "retry-same-step" | "jump-to-step";
  readonly maxRetries?: number;
  readonly retryTimeoutIncrementMs?: number;
  readonly jumpStepId?: string;
  readonly reuseBackendSession?: boolean;
}

export interface WorkflowStepTransition {
  readonly toStepId: string;
  readonly toWorkflowId?: string;
  readonly label?: string;
}

export interface WorkflowStepSessionPolicy {
  readonly mode?: "new" | "reuse";
  readonly inheritFromStepId?: string;
}

export interface WorkflowStepRef {
  readonly id: string;
  readonly stepFile?: string;
  readonly nodeId?: string;
  readonly description?: string;
  readonly role?: "manager" | "worker";
  readonly promptVariant?: string;
  readonly timeoutMs?: number;
  readonly sessionPolicy?: WorkflowStepSessionPolicy;
  readonly transitions?: readonly WorkflowStepTransition[];
}

export interface WorkflowJson {
  readonly workflowId: string;
  readonly description: string;
  readonly defaults: WorkflowDefaults;
  readonly entryStepId: string;
  readonly managerStepId?: string;
  readonly nodes: readonly WorkflowNodeRef[];
  readonly steps: readonly WorkflowStepRef[];
}
```

**Checklist**:

- [ ] Remove legacy authored fields and types from the primary workflow schema
- [ ] Add file-backed and inline `steps[]` support with strict validation
- [ ] Make `workflow.json.nodes[]` a pure reusable registry rather than ordered execution
- [ ] Reject removed fields such as `workflowCalls`, `edges`, `loops`, and structural sub-workflow metadata
- [ ] Update create/save/load/inspect surfaces to emit only the new step-addressed shape

### 2. Step Execution State and Unified `call-step`

#### `src/workflow/call-step.ts`, `src/workflow/session.ts`, `src/workflow/session-store.ts`, `src/workflow/runtime-db.ts`, `src/workflow/node-execution-mailbox.ts`, `src/workflow/communication-service.ts`

**Status**: NOT_STARTED

```typescript
export interface ExecutionAddress {
  readonly workflowId: string;
  readonly stepId: string;
}

export interface StepCallOverrides {
  readonly promptVariant?: string;
  readonly sessionMode?: "new" | "reuse";
  readonly timeoutMs?: number;
}

export interface CallStepInput extends LoadOptions, SessionStoreOptions {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly stepId: string;
  readonly overrides?: StepCallOverrides;
  readonly message?: unknown;
  readonly defaultTimeoutMs?: number;
}

export interface AcceptedOutputMail {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly stepId: string;
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly mailboxInstanceId: string;
  readonly status: "success" | "fail" | "timeout";
  readonly reason?: string;
  readonly next?: {
    readonly workflowId?: string;
    readonly stepId: string;
    readonly promptVariant?: string;
    readonly sessionMode?: "new" | "reuse";
    readonly timeoutMs?: number;
  };
  readonly payload: Readonly<Record<string, unknown>>;
}
```

**Checklist**:

- [ ] Replace `call-node` with `call-step` and make step id the public execution target
- [ ] Persist step-addressed execution history, mailbox instance ids, and step-local overrides in session state
- [ ] Update runtime-db rows and mailbox artifacts to store `stepId` as a first-class field
- [ ] Keep backend-session reuse keyed by step/node policy without collapsing repeated step visits
- [ ] Remove old node-only execution assumptions from direct-call plumbing

### 3. Engine and Deterministic Manager Runtime

#### `src/workflow/engine.ts`, `src/workflow/manager-control.ts`, `src/workflow/prompt-composition.ts`, `src/workflow/input-assembly.ts`, `src/workflow/node-role.ts`, `src/workflow/semantics.ts`, `src/workflow/sub-workflow.ts`, `src/workflow/conversation.ts`

**Status**: NOT_STARTED

```typescript
export interface ManagerRuntimeDecision {
  readonly action: "call-step" | "complete-workflow" | "fail-workflow";
  readonly target?: ExecutionAddress;
  readonly promptVariant?: string;
  readonly sessionMode?: "new" | "reuse";
  readonly timeoutMs?: number;
  readonly reason?: string;
}

export type ManagerControlActionType =
  | "planner-note"
  | "retry-step"
  | "replay-communication"
  | "execute-optional-step"
  | "skip-optional-step";
```

**Checklist**:

- [ ] Replace edge/loop/sub-workflow planning with validated step-transition execution
- [ ] Make `managerType: "code"` the default manager behavior and keep `llm` explicitly opt-in
- [ ] Apply workflow/step timeout policy deterministically from manager/runtime code
- [ ] Resolve prompt variants and same-session continuation when revisiting shared nodes
- [ ] Delete obsolete structural sub-workflow and branch/loop runtime paths instead of preserving them

### 4. Public Surfaces and Inspection

#### `src/lib.ts`, `src/cli.ts`, `src/graphql/schema.ts`, `src/graphql/types.ts`, `src/server/graphql.ts`, `src/tui/opentui-model/**/*.ts`, `src/tui/components/WorkflowDefinitionScreen.tsx`

**Status**: NOT_STARTED

```typescript
export interface WorkflowInspectionSummary {
  readonly workflowId: string;
  readonly entryStepId: string;
  readonly managerStepId?: string;
  readonly stepIds: readonly string[];
  readonly nodeRegistryIds: readonly string[];
}

export interface SessionRerunInput {
  readonly sessionId: string;
  readonly stepId: string;
  readonly workflowWorkingDirectory?: string;
}
```

**Checklist**:

- [ ] Rename CLI/library/GraphQL public execution surfaces from node to step where the user targets execution
- [ ] Replace `call-node` documentation and command text with `call-step`
- [ ] Update `session progress`, `session rerun`, and workflow inspection output to report step-centric state
- [ ] Reflect reusable node registry versus step graph separation in TUI and GraphQL summaries
- [ ] Keep any remaining node wording limited to reusable payload definitions, not execution addresses

### 5. Examples, Documentation, and Regression Replacement

#### `examples/**/*`, `README.md`, `design-docs/specs/*.md`, `src/workflow/*.test.ts`, `src/cli.test.ts`, `src/graphql/schema.test.ts`, `src/server/graphql.test.ts`, `src/tui/**/*.test.ts`

**Status**: NOT_STARTED

```typescript
interface StepAddressedExampleSet {
  readonly workflowId: string;
  readonly stepIds: readonly string[];
  readonly sharedNodeIds: readonly string[];
  readonly crossWorkflowTargets: readonly ExecutionAddress[];
}
```

**Checklist**:

- [ ] Replace legacy example bundles with step-addressed bundles and reusable-node examples
- [ ] Add regression coverage for prompt variants, shared-node revisits, timeout-policy routing, and unified cross-workflow step calls
- [ ] Remove tests that only protect deleted branch/loop/sub-workflow authoring
- [ ] Align README, architecture, command docs, and notes with the new cutover
- [ ] Verify no shipped example still depends on removed compatibility fields

## Module Status

| Module | File Path | Status | Tests |
| ------ | --------- | ------ | ----- |
| Authored schema and bundle I/O | `src/workflow/types.ts`, `src/workflow/json-schema.ts`, `src/workflow/validate.ts`, `src/workflow/load.ts`, `src/workflow/save.ts`, `src/workflow/inspect.ts`, `src/workflow/create.ts` | NOT_STARTED | `src/workflow/validate.test.ts`, `src/workflow/load.test.ts`, `src/workflow/save.test.ts`, `src/workflow/json-schema.test.ts` |
| Step execution state and unified `call-step` | `src/workflow/call-step.ts`, `src/workflow/session.ts`, `src/workflow/runtime-db.ts`, `src/workflow/node-execution-mailbox.ts` | NOT_STARTED | `src/workflow/call-step.test.ts`, `src/workflow/runtime-db.test.ts`, `src/workflow/session-store.test.ts` |
| Engine and deterministic manager runtime | `src/workflow/engine.ts`, `src/workflow/manager-control.ts`, `src/workflow/prompt-composition.ts`, `src/workflow/input-assembly.ts` | NOT_STARTED | `src/workflow/engine.test.ts`, `src/workflow/manager-control.test.ts`, `src/workflow/prompt-composition.test.ts`, `src/workflow/input-assembly.test.ts` |
| Public surfaces and inspection | `src/lib.ts`, `src/cli.ts`, `src/graphql/schema.ts`, `src/tui/**/*` | NOT_STARTED | `src/lib.test.ts`, `src/cli.test.ts`, `src/graphql/schema.test.ts`, `src/server/graphql.test.ts`, `src/tui/opentui-screen.test.ts` |
| Examples, docs, and regression replacement | `examples/**/*`, `README.md`, `design-docs/specs/*.md` | NOT_STARTED | targeted example-validation and repository regression slices |

## Dependencies

| Feature | Depends On | Status |
| ------- | ---------- | ------ |
| Authored schema and bundle I/O | Existing workflow save/load foundation | READY |
| Step execution state and unified `call-step` | Authored schema and bundle I/O | BLOCKED |
| Engine and deterministic manager runtime | Authored schema and step execution state | BLOCKED |
| Public surfaces and inspection | Authored schema and step execution state | BLOCKED |
| Examples, docs, and regression replacement | Schema, runtime, and public-surface cutover | BLOCKED |

## Completion Criteria

- [ ] The repository accepts only the step-addressed authored workflow model on the primary path
- [ ] `workflow.json.nodes[]` is treated only as a reusable node registry
- [ ] Runtime execution, mailbox artifacts, and runtime-db state are step-addressed
- [ ] `call-step` is the single direct execution primitive for local and cross-workflow calls
- [ ] Code manager is the default manager runtime and timeout policy is deterministic
- [ ] Prompt-variant revisits and shared-node session reuse work with distinct mailbox instances
- [ ] CLI, GraphQL, TUI, examples, and README all describe the step-addressed model consistently
- [ ] `bun run typecheck:server`, targeted runtime tests, and the full regression suite pass

## Progress Log

### Session: 2026-04-24 00:00 JST
**Tasks Completed**: Plan creation
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Created from the 2026-04-24 design-document diff that converges architecture, workflow JSON, command docs, and QA notes on the step-addressed runtime. Per user instruction, backward compatibility is not part of this cutover plan; the intent is replacement, not migration-layer expansion.

## Related Plans

- **Previous**: `impl-plans/workflow-role-unification-structural-cleanup.md`
- **Next**: `impl-plans/auto-improve-superviser-mode.md`
- **Depends On**: `impl-plans/workflow-role-unification.md`, `impl-plans/workflow-role-unification-structural-cleanup.md`, `impl-plans/node-session-reuse.md`, `impl-plans/manager-driven-call-node-runtime.md`
