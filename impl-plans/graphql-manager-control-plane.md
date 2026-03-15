# GraphQL Manager Control Plane Implementation Plan

**Status**: Ready
**Design Reference**: design-docs/specs/design-graphql-manager-control-plane.md
**Created**: 2026-03-15
**Last Updated**: 2026-03-15

## Design Document Reference

**Source**: `design-docs/specs/design-graphql-manager-control-plane.md`

### Summary

Promote GraphQL to the canonical control-plane interface for workflow execution, communication inspection/replay, and manager-driven orchestration, while keeping mailbox/session artifacts and existing runtime execution semantics intact.

### Scope

**Included**:
- GraphQL schema and local server integration
- communication inspection and replay/retry services
- manager-session and manager-message persistence
- generic `oyakata gql` CLI GraphQL client
- CLI layering over GraphQL execution flows
- typed manager action inputs, scoped bearer-token auth, and persisted idempotency behavior
- migration-safe documentation updates for root-path precedence and REST coexistence

**Excluded**:
- full browser UI migration in the same plan
- distributed multi-host orchestration
- replacement of workflow JSON with GraphQL-authored definitions

## Modules

### 1. GraphQL Domain Types and Schema

#### src/graphql/types.ts

**Status**: NOT_STARTED

```typescript
export interface CommunicationLookupInput {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly communicationId: string;
}

export interface ReplayCommunicationInput extends CommunicationLookupInput {
  readonly idempotencyKey?: string;
  readonly reason?: string;
}

export interface RetryCommunicationDeliveryInput
  extends CommunicationLookupInput {
  readonly idempotencyKey?: string;
  readonly reason?: string;
}

export interface SendManagerMessageInput {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly message?: string;
  readonly actions?: readonly ManagerControlActionInput[];
  readonly attachments?: readonly DataDirFileRef[];
  readonly idempotencyKey?: string;
  readonly managerSessionId?: string;
  readonly managerNodeId?: string;
  readonly managerNodeExecId?: string;
}

export type ManagerControlActionInput =
  | { readonly kind: "planner-note" }
  | {
      readonly kind: "start-sub-workflow";
      readonly subWorkflowId: string;
    }
  | {
      readonly kind: "deliver-to-child-input";
      readonly inputNodeId: string;
    }
  | { readonly kind: "retry-node"; readonly nodeId: string }
  | {
      readonly kind: "replay-communication";
      readonly communicationId: string;
      readonly reason?: string;
    };

export interface DataDirFileRef {
  readonly path: string;
  readonly mediaType?: string;
}

export interface SendManagerMessageResult {
  readonly accepted: boolean;
  readonly managerMessageId: string;
  readonly parsedActions: readonly ManagerIntentSummary[];
  readonly createdCommunicationIds: readonly string[];
  readonly queuedNodeIds: readonly string[];
  readonly rejectionReason?: string;
}

export interface ManagerIntentSummary {
  readonly kind:
    | "planner-note"
    | "start-sub-workflow"
    | "deliver-to-child-input"
    | "retry-node"
    | "replay-communication"
    | "wait"
    | "invalid";
  readonly targetId?: string;
  readonly reason?: string;
}
```

**Checklist**:
- [ ] Define GraphQL-facing input/output types
- [ ] Define communication inspection payload shape
- [ ] Define manager send payload/result shape with typed manager actions
- [ ] Define data-root-relative file reference type for image/file attachments
- [ ] Define replay/retry payload shapes
- [ ] Define auth/idempotency support types for scoped manager mutations

#### src/graphql/schema.ts

**Status**: NOT_STARTED

```typescript
export interface GraphqlSchemaFactoryInput {
  readonly services: GraphqlControlPlaneServices;
}

export interface GraphqlControlPlaneServices {
  readonly getWorkflowExecution(
    workflowExecutionId: string,
  ): Promise<WorkflowExecutionGraphqlView | null>;
  readonly getCommunication(
    input: CommunicationLookupInput,
  ): Promise<CommunicationGraphqlView | null>;
  readonly sendManagerMessage(
    input: SendManagerMessageInput,
    context: GraphqlRequestContext,
  ): Promise<SendManagerMessageResult>;
  readonly replayCommunication(
    input: ReplayCommunicationInput,
    context: GraphqlRequestContext,
  ): Promise<ReplayCommunicationResult>;
  readonly retryCommunicationDelivery(
    input: RetryCommunicationDeliveryInput,
    context: GraphqlRequestContext,
  ): Promise<RetryCommunicationDeliveryResult>;
  readonly rememberIdempotentResult(
    input: IdempotentMutationRecord,
  ): Promise<void>;
  readonly loadIdempotentResult(
    input: IdempotentMutationLookup,
  ): Promise<IdempotentMutationRecord | null>;
}
```

**Checklist**:
- [ ] Define schema factory boundary
- [ ] Expose queries for workflow execution and communication inspection
- [ ] Expose mutations for send, replay, retry, execute, rerun, resume, cancel
- [ ] Keep schema names aligned with the design doc
- [ ] Enforce typed manager actions rather than prose-only command parsing
- [ ] Define conflict behavior for reused idempotency keys with changed payloads

### 2. Communication Inspection and Replay Services

#### src/workflow/communication-service.ts

**Status**: NOT_STARTED

```typescript
export interface CommunicationArtifactSnapshot {
  readonly messageJson: string | null;
  readonly metaJson: string | null;
  readonly outboxMessageJson: string | null;
  readonly outboxOutputRaw: string | null;
  readonly inboxMessageJson: string | null;
  readonly attemptFiles: readonly CommunicationAttemptSnapshot[];
}

export interface CommunicationAttemptSnapshot {
  readonly deliveryAttemptId: string;
  readonly attemptJson: string | null;
  readonly receiptJson: string | null;
}

export interface CommunicationGraphqlView {
  readonly record: CommunicationRecord;
  readonly sourceNodeExecution: NodeExecutionRecord | null;
  readonly consumedByNodeExecution: NodeExecutionRecord | null;
  readonly artifactSnapshot: CommunicationArtifactSnapshot;
}

export interface ReplayCommunicationResult {
  readonly sourceCommunicationId: string;
  readonly workflowExecutionId: string;
  readonly replayedCommunicationId: string;
  readonly status: CommunicationRecord["status"];
}

export interface RetryCommunicationDeliveryResult {
  readonly communicationId: string;
  readonly activeDeliveryAttemptId: string;
  readonly status: CommunicationRecord["status"];
}

export function createCommunicationService(
  deps: CommunicationServiceDependencies,
): CommunicationService;
```

**Checklist**:
- [ ] Load communication artifacts by `(workflowId, workflowExecutionId, communicationId)`
- [ ] Return mailbox snapshots plus derived execution status
- [ ] Implement replay as a new `communicationId` allocation
- [ ] Implement delivery retry as same `communicationId` plus new `deliveryAttemptId`
- [ ] Preserve mailbox invariants from `design-node-mailbox.md`

### 3. Manager Session and Message Persistence

#### src/workflow/manager-session-store.ts

**Status**: NOT_STARTED

```typescript
export interface ManagerSessionRecord {
  readonly managerSessionId: string;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly managerNodeId: string;
  readonly managerNodeExecId: string;
  readonly status: "active" | "completed" | "failed" | "cancelled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastMessageId?: string;
  readonly authTokenHash: string;
  readonly authTokenExpiresAt: string;
}

export interface ManagerMessageRecord {
  readonly managerMessageId: string;
  readonly managerSessionId: string;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly managerNodeId: string;
  readonly managerNodeExecId: string;
  readonly message?: string;
  readonly parsedIntent: readonly ManagerIntentSummary[];
  readonly accepted: boolean;
  readonly rejectionReason?: string;
  readonly createdAt: string;
}

export interface IdempotentMutationRecord {
  readonly mutationName: string;
  readonly managerSessionId: string;
  readonly idempotencyKey: string;
  readonly normalizedRequestHash: string;
  readonly responseJson: string;
  readonly completedAt: string;
}

export interface IdempotentMutationLookup {
  readonly mutationName: string;
  readonly managerSessionId: string;
  readonly idempotencyKey: string;
}

export interface ManagerSessionStore {
  createOrResumeSession(input: ManagerSessionRecord): Promise<ManagerSessionRecord>;
  appendMessage(input: ManagerMessageRecord): Promise<ManagerMessageRecord>;
  loadSession(managerSessionId: string): Promise<ManagerSessionRecord | null>;
  listMessages(managerSessionId: string): Promise<readonly ManagerMessageRecord[]>;
  saveIdempotentResult(
    input: IdempotentMutationRecord,
  ): Promise<IdempotentMutationRecord>;
  loadIdempotentResult(
    input: IdempotentMutationLookup,
  ): Promise<IdempotentMutationRecord | null>;
}
```

**Checklist**:
- [ ] Persist manager sessions separate from workflow session snapshots
- [ ] Persist append-only manager messages
- [ ] Support auth/context lookup by manager session and node execution
- [ ] Expose retrieval for GraphQL queries and debugging
- [ ] Persist scoped idempotent mutation records

### 4. Server GraphQL Integration

#### src/server/graphql.ts

**Status**: NOT_STARTED

```typescript
export interface GraphqlRequestContext {
  readonly workflowRoot?: string;
  readonly artifactRoot?: string;
  readonly sessionStoreRoot?: string;
  readonly rootDataDir?: string;
  readonly authToken?: string;
  readonly authScheme?: "bearer";
  readonly managerSessionId?: string;
  readonly managerNodeId?: string;
  readonly managerNodeExecId?: string;
  readonly managerScope?: {
    readonly workflowExecutionId: string;
    readonly managerSessionId: string;
    readonly managerNodeId: string;
    readonly managerNodeExecId: string;
  };
}

export interface GraphqlHttpHandlerOptions extends ApiContext {
  readonly introspection?: boolean;
}

export async function handleGraphqlRequest(
  request: Request,
  options: GraphqlHttpHandlerOptions,
): Promise<Response>;
```

**Checklist**:
- [ ] Add `/graphql` server handler
- [ ] Route GraphQL operations through shared application services
- [ ] Support bearer-token auth/context extraction for manager tool calls
- [ ] Resolve `DataDirFileRef` paths under the configured root data directory
- [ ] Add server tests for queries and mutations
- [ ] Enforce per-surface root-path precedence from the corrected design doc

### 5. CLI GraphQL Client and Manager Tool Wrapper

#### src/graphql/client.ts

**Status**: NOT_STARTED

```typescript
export interface GraphqlClientOptions {
  readonly endpoint: string;
  readonly authToken?: string;
}

export interface GraphqlCliClient {
  executeDocument<TResult = unknown>(input: {
    readonly document: string;
    readonly variables?: Readonly<Record<string, unknown>>;
  }): Promise<TResult>;
}
```

**Checklist**:
- [ ] Add a minimal GraphQL client for CLI use
- [ ] Implement `oyakata gql`
- [ ] Support `--variables` for GraphQL variables using inline JSON or `@path/to/variables.json`
- [ ] Resolve manager auth/env context from ambient environment for LLM tool use
- [ ] Pass manager auth as bearer-token transport rather than ad hoc payload fields

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| GraphQL domain types | `src/graphql/types.ts` | NOT_STARTED | - |
| GraphQL schema | `src/graphql/schema.ts` | NOT_STARTED | - |
| Communication service | `src/workflow/communication-service.ts` | NOT_STARTED | - |
| Manager session store | `src/workflow/manager-session-store.ts` | NOT_STARTED | - |
| GraphQL server handler | `src/server/graphql.ts` | NOT_STARTED | - |
| CLI GraphQL client | `src/graphql/client.ts` | NOT_STARTED | - |
| CLI integration | `src/cli.ts` | NOT_STARTED | - |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Communication service | Existing session/mailbox artifact model | READY |
| Manager session store | Communication service type layer | READY |
| GraphQL schema | Communication service, manager session store | BLOCKED |
| Server GraphQL integration | GraphQL schema | BLOCKED |
| Generic CLI GraphQL client | Server GraphQL integration, GraphQL client | BLOCKED |

## Tasks

### TASK-001: Communication Service Foundation

**Status**: NOT_STARTED
**Parallelizable**: Yes

**Deliverables**:
- `src/workflow/communication-service.ts`
- `src/workflow/communication-service.test.ts`

**Completion Criteria**:
- [ ] Communication lookup loads record plus artifact snapshots
- [ ] GraphQL-facing communication view type exists
- [ ] Replay allocates a new `communicationId`
- [ ] Delivery retry allocates a new `deliveryAttemptId`
- [ ] Replay/retry honor persisted idempotent result lookups when keys are provided

### TASK-002: Manager Session Persistence

**Status**: NOT_STARTED
**Parallelizable**: Yes

**Deliverables**:
- `src/workflow/manager-session-store.ts`
- `src/workflow/manager-session-store.test.ts`

**Completion Criteria**:
- [ ] Manager session record storage exists
- [ ] Manager message append log exists
- [ ] Ambient manager execution context can be resolved safely
- [ ] Persistence tests cover creation, append, and reload
- [ ] Bearer token scope and expiry metadata are persisted
- [ ] Duplicate idempotency-key lookups are persisted and test-covered

### TASK-003: GraphQL Schema and Server Integration

**Status**: NOT_STARTED
**Parallelizable**: No

**Deliverables**:
- `src/graphql/types.ts`
- `src/graphql/schema.ts`
- `src/server/graphql.ts`
- `src/server/graphql.test.ts`

**Dependencies**:
- `TASK-001`
- `TASK-002`

**Completion Criteria**:
- [ ] `/graphql` query/mutation surface is available
- [ ] Communication inspection query works
- [ ] Send/replay/retry mutations work
- [ ] Image/file attachment references are data-root-relative and reject host absolute paths
- [ ] Existing serve-mode execution flows run through GraphQL services
- [ ] Typed manager-action inputs are validated against existing ownership rules
- [ ] REST editor endpoints remain untouched and documented as migration compatibility

### TASK-004: Generic CLI GraphQL Client and Manager Tool Contract

**Status**: NOT_STARTED
**Parallelizable**: No

**Deliverables**:
- `src/graphql/client.ts`
- `src/cli.ts`
- `src/cli.test.ts`
- `src/workflow/prompts/oyakata-system-prompt.md`

**Dependencies**:
- `TASK-003`

**Completion Criteria**:
- [ ] `oyakata gql` is implemented
- [ ] GraphQL documents and variables can be sent from the CLI
- [ ] `--variables` supports inline JSON and file-backed variable loading
- [ ] Image/file attachment variables can be passed as `DataDirFileRef`
- [ ] Manager prompt/tool guidance references the new control path
- [ ] CLI sends auth through the standard bearer-token header

### TASK-005: GraphQL Surface and Documentation Consolidation

**Status**: NOT_STARTED
**Parallelizable**: No

**Deliverables**:
- `src/lib.ts`
- `README.md`
- `design-docs/specs/command.md`
- `design-docs/specs/architecture.md`
- `design-docs/specs/notes.md`

**Dependencies**:
- `TASK-003`
- `TASK-004`

**Completion Criteria**:
- [ ] Library API exposes GraphQL-compatible communication inspection/replay helpers
- [ ] README documents GraphQL as canonical for manager/execution operations without claiming REST editor removal before migration
- [ ] Serve-path documentation explains REST and GraphQL coexistence during migration
- [ ] Root-data-dir precedence is documented consistently with current override behavior

## Completion Criteria

- [ ] GraphQL endpoint exists and is documented as canonical
- [ ] Communication inspection is available by `workflowId + workflowExecutionId + communicationId`
- [ ] Communication replay and delivery retry semantics are distinct and tested
- [ ] `oyakata gql` works as the manager-tool client
- [ ] Typed manager actions, scoped bearer-token auth, and idempotency behavior are specified and tested
- [ ] First-iteration attachment handling assumes pre-placed files under the Oyakata root data directory; no upload mutation is required
- [ ] GraphQL file/image references are portable across host and container path layouts
- [ ] Existing runtime mailbox/session invariants remain intact
- [ ] Typecheck and relevant test suites pass

## Progress Log

### Session: 2026-03-15
**Tasks Completed**: Design investigation, redesign specification, implementation plan creation
**Tasks In Progress**: None
**Blockers**: None
**Notes**: The current runtime design is compatible with the requested direction at the execution/mailbox level, but the CLI/control-plane layering is not. This plan therefore introduces GraphQL and manager-session services as additive control-plane infrastructure rather than rewriting the engine first.
