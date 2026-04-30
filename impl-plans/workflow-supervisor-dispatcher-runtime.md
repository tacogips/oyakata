# Workflow Supervisor Dispatcher Runtime Implementation Plan

**Status**: Ready
**Design Reference**: `design-docs/specs/design-workflow-supervisor-dispatcher.md`
**Created**: 2026-04-30
**Last Updated**: 2026-04-30

## Related Plans

- **Previous**: `impl-plans/workflow-supervisor-dispatcher-foundation.md`
- **Depends On**: `impl-plans/workflow-supervisor-dispatcher-foundation.md`
- **Related**: `impl-plans/workflow-supervisor-dispatcher.md`
- **Related**: `impl-plans/completed/event-external-mailbox-binding-foundation.md`

## Design Document Reference

**Source**: `design-docs/specs/design-workflow-supervisor-dispatcher.md`,
`design-docs/specs/design-event-external-mailbox-binding.md`,
`design-docs/specs/architecture.md#event-listener-workflow-triggers`

### Summary

Build the runtime path that consumes the dispatcher foundation: apply validated
supervisor decisions, route `supervisor-dispatch` event bindings, expose local
and GraphQL entrypoints, and add examples and focused verification.

### Scope

**Included**: runtime dispatch service and scoped capabilities, mailbox/event
integration, GraphQL/server/library dispatcher entrypoints, packaged dispatcher
examples, and focused tests.

**Excluded**: TUI surfacing, profile migration tooling, and long-lived resumed
supervisor executions.

## Modules

### 1. Runtime Dispatch Service And Scoped Capabilities

#### `src/workflow/supervisor-dispatch-client.ts`, `src/workflow/supervisor-client.ts`, `src/workflow/superviser-control.ts`, `src/lib.ts`

**Status**: NOT_STARTED

```typescript
export interface DispatchSupervisorConversationInput extends LoadOptions {
  readonly sourceId: string;
  readonly bindingId: string;
  readonly correlationKey: string;
  readonly supervisorProfileId: string;
  readonly sourceMessageId: string;
  readonly event: ExternalEventEnvelope;
}

export interface WorkflowSupervisorDispatchClient {
  dispatchExternalInput(
    input: DispatchSupervisorConversationInput,
  ): Promise<WorkflowSupervisorDispatchView>;
}

export interface SupervisorRuntimeCapabilitySet {
  startManagedWorkflow(input: StartManagedWorkflowInput): Promise<ManagedWorkflowRunRecord>;
  submitManagedInput(input: SubmitManagedWorkflowInput): Promise<ManagedWorkflowRunRecord>;
  stopManagedWorkflow(input: StopManagedWorkflowInput): Promise<ManagedWorkflowRunRecord>;
}
```

**Checklist**:

- [ ] Implement one dispatcher entrypoint that validates proposals and applies compare-and-swap updates
- [ ] Scope lifecycle actions to the pinned profile snapshot and conversation-owned runs
- [ ] Normalize terminal-run `submit-input` behavior in one runtime layer
- [ ] Enforce alias uniqueness and selection updates for `single-selected` and `multiple-active`

### 2. Event Trigger And External Mailbox Integration

#### `src/events/trigger-runner.ts`, `src/events/dispatch-supervisor-chat.ts`, `src/events/listener-service.ts`, `src/events/mailbox-bridge-policy.ts`

**Status**: NOT_STARTED

```typescript
export interface WorkflowTriggerResult {
  readonly workflowExecutionId?: string;
  readonly supervisedRunId?: string;
  readonly supervisorConversationId?: string;
  readonly supervisorDecisionId?: string;
}
```

**Checklist**:

- [ ] Route `supervisor-dispatch` bindings through the new dispatch client
- [ ] Preserve `execution.mode = "supervised"` behavior unchanged
- [ ] Use supervisor conversation ownership for runtime-published external output
- [ ] Test replay, stale decision rejection, and ambiguous parallel-run targeting

### 3. GraphQL, Library Surface, And Verification Assets

#### `src/graphql/types.ts`, `src/graphql/schema.ts`, `src/server/graphql-executable-schema.ts`, `src/workflow/supervisor-graphql-client.ts`, `examples/default-supervisor-dispatcher/`

**Status**: NOT_STARTED

```typescript
export interface DispatchSupervisorConversationGraphqlInput {
  readonly sourceId: string;
  readonly bindingId: string;
  readonly correlationKey: string;
  readonly supervisorProfileId: string;
  readonly sourceMessageId: string;
  readonly event: Readonly<Record<string, unknown>>;
}

export interface DispatchSupervisorConversationPayload {
  readonly accepted: boolean;
  readonly view?: WorkflowSupervisorConversationView;
  readonly error?: string;
}
```

**Checklist**:

- [ ] Add GraphQL inputs and payloads for dispatch and conversation reads
- [ ] Expose the same dispatcher contract through local and remote clients
- [ ] Package a default dispatcher example with supervisor profile files and managed workflow examples
- [ ] Cover direct answer, start, submit, switch, stop, restart, status, ambiguity rejection, and replay safety

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Runtime dispatch client | `src/workflow/supervisor-dispatch-client.ts`, `src/workflow/supervisor-client.ts`, `src/workflow/superviser-control.ts`, `src/lib.ts` | NOT_STARTED | planned |
| Event integration | `src/events/trigger-runner.ts`, `src/events/dispatch-supervisor-chat.ts`, `src/events/listener-service.ts`, `src/events/mailbox-bridge-policy.ts` | NOT_STARTED | planned |
| GraphQL/library surface and examples | `src/graphql/types.ts`, `src/graphql/schema.ts`, `src/server/graphql-executable-schema.ts`, `src/workflow/supervisor-graphql-client.ts`, `examples/default-supervisor-dispatcher/` | NOT_STARTED | planned |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| TASK-004 Runtime dispatch service and scoped capabilities | foundation `TASK-002`, foundation `TASK-003` | BLOCKED |
| TASK-005 Event binding routing for `supervisor-dispatch` | TASK-004 | BLOCKED |
| TASK-006 GraphQL and library dispatcher entrypoints | TASK-004 | BLOCKED |
| TASK-007 Examples and focused test coverage | TASK-005, TASK-006 | BLOCKED |

## Tasks

### TASK-004: Runtime Dispatch Service And Scoped Capabilities

**Status**: Ready
**Parallelizable**: No

**Dependencies**:

- foundation `TASK-002`
- foundation `TASK-003`

**Deliverables**:

- `src/workflow/supervisor-dispatch-client.ts`
- `src/workflow/supervisor-client.ts`
- `src/workflow/superviser-control.ts`
- `src/lib.ts`
- focused runtime tests for idempotency, stale state, and alias selection

**Completion Criteria**:

- [ ] One runtime entrypoint validates and applies dispatch proposals
- [ ] Lifecycle actions are limited to conversation-owned runs within the pinned profile
- [ ] Terminal-run follow-up input is normalized as clarify/restart/fork in one place
- [ ] `runAlias` uniqueness and selection updates are deterministic and test-covered

### TASK-005: Event Binding Routing For `supervisor-dispatch`

**Status**: Ready
**Parallelizable**: No

**Dependencies**:

- `TASK-004`

**Deliverables**:

- `src/events/trigger-runner.ts`
- `src/events/dispatch-supervisor-chat.ts`
- `src/events/listener-service.ts`
- `src/events/mailbox-bridge-policy.ts`
- event-path tests for replay and ambiguity handling

**Completion Criteria**:

- [ ] Dispatcher mode routes through the new runtime client
- [ ] Existing supervised mode remains backward compatible
- [ ] External output ownership stays bound to the supervisor conversation
- [ ] Replay, stale decision, and ambiguous target failures are covered by tests

### TASK-006: GraphQL And Library Dispatcher Entrypoints

**Status**: Ready
**Parallelizable**: Yes

**Dependencies**:

- `TASK-004`

**Deliverables**:

- `src/graphql/types.ts`
- `src/graphql/schema.ts`
- `src/server/graphql-executable-schema.ts`
- `src/workflow/supervisor-graphql-client.ts`
- GraphQL schema and HTTP transport tests

**Completion Criteria**:

- [ ] GraphQL exposes dispatcher mutation and conversation read surfaces
- [ ] Local and remote clients share the same dispatcher semantics
- [ ] Auth boundaries and stale/replay semantics are preserved through transport tests
- [ ] Terminal-input normalization is observable through GraphQL payloads

### TASK-007: Examples And Focused Test Coverage

**Status**: Ready
**Parallelizable**: Yes

**Dependencies**:

- `TASK-005`
- `TASK-006`

**Deliverables**:

- `examples/default-supervisor-dispatcher/`
- `examples/event-sources/`
- focused tests under `src/events/*.test.ts` and `src/workflow/*.test.ts`

**Completion Criteria**:

- [ ] Packaged examples include supervisor profiles and managed workflow catalog entries
- [ ] Example flows cover `single-selected` state and terminal-input behavior
- [ ] Focused tests cover direct answer, start, submit, switch, stop, restart, and status
- [ ] Parallel-run alias rules and replay safety are covered in targeted tests

## Completion Criteria

- [ ] Runtime, event, GraphQL, and example TODOs are mapped to executable tasks
- [ ] Runtime tasks describe the concrete files and tests needed for delivery
- [ ] The runtime plan depends only on the foundation contracts defined upstream

## Progress Log

### Session: 2026-04-30 00:00
**Tasks Completed**: None yet
**Tasks In Progress**: Planning split from umbrella dispatcher plan
**Blockers**: Waiting on foundation contracts and persistence tasks
**Notes**: This plan owns the delivery path from validated dispatcher decisions
to runtime mutation, transport exposure, and verification assets.
