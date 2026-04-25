# Auto Improve Superviser Workflow Phase 2 Implementation Plan

**Status**: Ready
**Design Reference**: `design-docs/specs/design-auto-improve-superviser-mode.md#implementation-phasing`, `design-docs/specs/architecture.md#auto-improve-supervision-boundary`, `design-docs/specs/command.md#subcommands`
**Created**: 2026-04-25
**Last Updated**: 2026-04-25

---

## Design Document Reference

**Source**:

- `design-docs/specs/design-auto-improve-superviser-mode.md`
- `design-docs/specs/architecture.md`
- `design-docs/specs/command.md`

### Summary

Implement phase 2 of `auto improve mode` by running `superviserWorkflowId` as a
normal step-addressed workflow instead of keeping remediation policy only inside
the engine loop. The existing phase-1 supervision state, incident history, and
patch-audit records remain the durable audit contract.

### Scope

**Included**:

- nested superviser workflow launch and lifecycle wiring
- runtime control operations the superviser workflow can call for target-run
  start/status/rerun/load/save
- supervision-state handoff between the target session and nested superviser
  execution
- CLI/library/inspection updates required to surface nested superviser session
  identity and status
- regression coverage and examples for the nested superviser path

**Excluded**:

- recursive self-supervision
- autonomous free-form workflow editing outside the constrained control surface
- browser-first supervision UX

---

## Modules

### 1. Superviser Workflow Runtime Control Surface

#### `src/workflow/local-node-addons.ts`, `src/workflow/call-step.ts`, `src/workflow/types.ts`

**Status**: NOT_STARTED

```typescript
export interface StartWorkflowAddonInput {
  readonly workflowId: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly autoImprove?: AutoImprovePolicy;
}

export interface GetWorkflowStatusAddonInput {
  readonly sessionId: string;
}

export interface SaveWorkflowDefinitionAddonInput {
  readonly workflowId: string;
  readonly mutableWorkflowDir: string;
}
```

**Checklist**:

- [ ] Define control-operation input/output types for target workflow actions
- [ ] Expose runtime-owned add-ons or equivalent internal actions for start/status/rerun/load/save
- [ ] Keep target-session authorization scoped to the owning supervision run
- [ ] Add unit tests for control-surface validation

### 2. Nested Superviser Session Orchestration

#### `src/workflow/engine.ts`, `src/workflow/superviser.ts`, `src/workflow/session.ts`

**Status**: NOT_STARTED

```typescript
export interface NestedSuperviserLaunch {
  readonly superviserWorkflowId: string;
  readonly targetSessionId: string;
  readonly supervisionRunId: string;
}

export interface SupervisionRunState {
  readonly supervisionRunId: string;
  readonly targetWorkflowId: string;
  readonly superviserWorkflowId: string;
  readonly nestedSuperviserSessionId?: string;
}
```

**Checklist**:

- [ ] Start the nested superviser workflow when phase-2 supervision is enabled
- [ ] Persist nested superviser session identity on the target supervision state
- [ ] Resume and rerun nested supervision without losing prior incidents or remediations
- [ ] Preserve phase-1 audit records and mutable-workspace behavior

### 3. Public Surfaces and Operator Inspection

#### `src/cli.ts`, `src/lib.ts`, `src/graphql/schema.ts`, `src/server/graphql-executable-schema.ts`

**Status**: NOT_STARTED

```typescript
export interface SupervisionSummary {
  readonly supervisionRunId: string;
  readonly targetWorkflowId: string;
  readonly superviserWorkflowId: string;
  readonly nestedSuperviserSessionId?: string;
  readonly status: "running" | "succeeded" | "failed" | "stopped";
}
```

**Checklist**:

- [ ] Surface nested superviser session identity in CLI, library, and GraphQL inspection
- [ ] Keep existing `--auto-improve` policy flags stable
- [ ] Document the difference between phase-1 engine loop and phase-2 nested superviser execution during rollout
- [ ] Add regression coverage for inspection output

### 4. Examples and End-to-End Verification

#### `examples/auto-improve/`, `examples/supervised-mock-retry/`, `src/workflow/*.test.ts`

**Status**: NOT_STARTED

```typescript
interface NestedSuperviserExample {
  readonly targetWorkflowId: string;
  readonly superviserWorkflowId: string;
  readonly expectedRemediationActions: readonly string[];
}
```

**Checklist**:

- [ ] Add an example bundle that includes an authored superviser workflow
- [ ] Cover success, rerun, patch, and stop-supervision flows end to end
- [ ] Verify resume/restart behavior for both target and superviser sessions
- [ ] Document operator-visible artifacts for the nested workflow path

---

## Module Status

| Module | File Path | Status | Tests |
| ------ | --------- | ------ | ----- |
| Superviser workflow runtime control surface | `src/workflow/local-node-addons.ts`, `src/workflow/call-step.ts`, `src/workflow/types.ts` | NOT_STARTED | - |
| Nested superviser session orchestration | `src/workflow/engine.ts`, `src/workflow/superviser.ts`, `src/workflow/session.ts` | NOT_STARTED | - |
| Public surfaces and operator inspection | `src/cli.ts`, `src/lib.ts`, `src/graphql/schema.ts`, `src/server/graphql-executable-schema.ts` | NOT_STARTED | - |
| Examples and end-to-end verification | `examples/auto-improve/`, `examples/supervised-mock-retry/`, `src/workflow/*.test.ts` | NOT_STARTED | - |

## Dependencies

| Feature | Depends On | Status |
| ------- | ---------- | ------ |
| Phase-2 nested superviser workflow | `auto-improve-superviser-mode`, `auto-improve-supervision-review-follow-up` | Ready |

## Completion Criteria

- [ ] `superviserWorkflowId` executes as a nested step-addressed workflow
- [ ] Target-session supervision state records nested superviser session identity
- [ ] Runtime-owned control operations let the nested superviser inspect and rerun the target workflow safely
- [ ] CLI/library/GraphQL inspection surfaces expose the nested superviser execution
- [ ] Regression tests cover nested supervision success, retry, patch, and resume flows

## Progress Log

### Session: 2026-04-25 00:00
**Tasks Completed**: Plan creation only
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Design review confirmed the current codebase is phase 1 only. `architecture.md` and `command.md` were updated to describe the shipped engine-owned supervision loop, and this plan tracks the remaining phase-2 nested superviser workflow work.

### Session: 2026-04-25 00:00
**Tasks Completed**: Phase-2 scope reassessment
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Review of the current tree confirmed that phase 1 follow-up hardening landed in `src/workflow/engine.ts`, `src/workflow/auto-improve-policy.ts`, and `src/workflow/mutable-workspace.ts`, but phase 2 itself still has not started. The runtime exposes operator-facing start/rerun/load/save surfaces through library and GraphQL entry points, yet there are still no runtime-owned superviser control add-ons, no nested `superviserWorkflowId` launch path, and no supervision-run authorization boundary for those operations. `TASK-001` remains the next executable implementation step.

## Related Plans

- **Previous**: `impl-plans/completed/auto-improve-superviser-mode.md`
- **Next**: (none yet)
- **Depends On**: `impl-plans/completed/auto-improve-supervision-review-follow-up.md`
