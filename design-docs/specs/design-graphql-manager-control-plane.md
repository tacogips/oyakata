# GraphQL Manager Control Plane

This document defines the redesign that promotes GraphQL to the canonical control-plane interface for workflow execution, communication inspection, and manager-driven orchestration.

## Overview

The current `oyakata` runtime already has strong domain primitives:

- workflow definitions and sub-workflow boundaries,
- workflow-execution/session persistence,
- mailbox-backed inter-node communication,
- manager-owned routing and replay constraints,
- deterministic node execution artifacts.

The main mismatch with the requested direction is not the execution model. It is the control surface.

Today the primary surfaces are:

- positional/flag-driven CLI commands,
- manager outputs that optionally embed `payload.managerControl.actions`.

The requested direction requires:

- a first-class workflow manager interaction surface that `oyakata` LLM nodes can call directly,
- communication inspection and replay by `workflowId` + `workflowExecutionId` + `communicationId`,
- GraphQL as the canonical domain-parameter transport instead of CLI flags or REST route-specific request shapes.

## Compatibility Assessment

### No Fundamental Conflict

The requested redesign does not fundamentally conflict with the current runtime architecture in these areas:

- `workflow.json` / `node-*.json` remain valid workflow-definition sources.
- `workflowExecutionId`-scoped artifact directories remain valid.
- mailbox artifacts under `communications/{communicationId}/` remain the durable source of truth for routed sends.
- manager ownership rules from `design-node-mailbox.md` remain valid.
- session persistence and node execution artifacts remain valid.
- sub-workflow and conversation routing models remain valid.

### Real Conflicts

The redesign does conflict with the current surface architecture in these areas:

1. CLI domain parameters are currently expressed as positional arguments and option flags.
2. Browser/server execution APIs are currently REST/JSON route-specific rather than schema-driven.
3. Manager control is currently expressed as node output content, not as a first-class manager command channel.
4. There is no stable public concept of a communication query or communication replay API.
5. The current `oyakata` executable is a runtime entrypoint, not a manager-tool client with ambient execution identity.

### Resolution

The redesign resolves the conflict by changing interface layering, not by replacing the runtime model:

- GraphQL becomes the canonical control-plane API for domain operations.
- CLI becomes a thin GraphQL client.
- manager-output `managerControl.actions` becomes a compatibility mode rather than the long-term primary manager control path.
- mailbox/session artifacts remain durable runtime state and are not replaced by GraphQL.

## Design Goals

- Make GraphQL the canonical domain API for workflow execution, communication queries, send/replay, and manager inspection.
- Allow an `oyakata` manager node to call `oyakata gql "<graphql document>"` from inside its LLM/tool environment.
- Preserve current mailbox and execution auditability.
- Support communication inspection and communication replay without mutating historical artifacts in place.
- Keep the existing local-first deployment model.

## Non-Goals

- replacing workflow JSON with GraphQL-authored workflow definitions,
- removing artifact directories as source-of-truth runtime evidence,
- introducing distributed multi-host coordination in this iteration,
- allowing arbitrary worker nodes to bypass manager ownership and write peer deliveries directly.

## Canonical API Direction

GraphQL becomes the canonical control-plane endpoint exposed by `oyakata serve`:

- `POST /graphql`
- optional GraphQL IDE/introspection only in local development mode

Rule:

- domain parameters move into GraphQL query/mutation inputs,
- CLI flags are retained only for transport/bootstrap concerns such as endpoint selection, auth token, output format, and local debug overrides.
- `oyakata gql` supports GraphQL variables through a single `--variables` option that accepts inline JSON or a file reference syntax such as `@path/to/variables.json`
- during migration, GraphQL is the canonical execution/communication/manager control surface, while existing REST editor endpoints remain supported until their GraphQL replacements land

Examples:

- workflow execution options such as `runtimeVariables`, `maxSteps`, and `dryRun` belong in GraphQL mutation input
- communication identifiers belong in GraphQL query input
- CLI flags such as `--endpoint` or `--auth-token-env` remain transport concerns

## File and Image Reference Contract

GraphQL requests that need to reference images or other local files must not send host absolute paths.

### Rationale

- host absolute paths are not stable across machines
- host absolute paths are not stable across future containerized node execution
- Podman or other container runtimes should be able to mount the same Oyakata data directory at a different host path while preserving the logical file reference

### Canonical File Reference

GraphQL inputs must use a data-root-relative file reference:

```text
{workflowId}/{workflowExecutionId}/...
```

Recommended layout for user-provided or manager-provided attachments:

```text
{oyakataRootDataDir}/files/{workflowId}/{workflowExecutionId}/attachments/{fileName}
```

The GraphQL-visible file reference for that example is:

```text
files/{workflowId}/{workflowExecutionId}/attachments/{fileName}
```

Rules:

- the GraphQL caller passes only the data-root-relative path
- the runtime resolves the absolute filesystem path from the configured Oyakata root data directory
- the GraphQL caller must not pass a host absolute path such as `/home/user/...`
- the GraphQL caller must not pass `..` path traversal segments
- the runtime must reject paths that escape the configured root data directory
- attachment creation/upload is out of scope for the first iteration; files must already exist under the Oyakata root data directory before the GraphQL request is sent

### Configuration

The Oyakata root data directory is resolved from environment variable or config.

Design direction:

- introduce `OYAKATA_ROOT_DATA_DIR` as the canonical root-data setting for derived defaults
- keep explicit per-surface overrides authoritative for migration compatibility
- `artifactRoot`, session store paths, attachment paths, and future container-mounted work paths may all be derived from that root when more specific overrides are absent

Precedence:

1. explicit CLI flag for that surface
2. explicit surface-specific environment variable for that surface
3. derived path from `OYAKATA_ROOT_DATA_DIR`
4. built-in default

Initial derived defaults:

- artifact root: `{OYAKATA_ROOT_DATA_DIR}/workflow`
- session store root: `{OYAKATA_ROOT_DATA_DIR}/sessions`
- attachments root: `{OYAKATA_ROOT_DATA_DIR}/files`

This keeps file references portable between:

- direct host execution
- Podman/containerized node execution with bind mounts or named volumes
- future remote execution adapters that mirror the same logical data-root structure

### GraphQL Type Shape

The GraphQL schema should expose a reusable file reference input type:

```text
DataDirFileRef {
  path: String!
  mediaType: String
}
```

For image-bearing mutations, use this type instead of raw absolute string paths.

Example usage:

```graphql
mutation SendManagerMessage($input: SendManagerMessageInput!) {
  sendManagerMessage(input: $input) {
    accepted
    createdCommunicationIds
  }
}
```

With variables:

```json
{
  "input": {
    "workflowId": "demo-workflow",
    "workflowExecutionId": "wfexec-000123",
    "message": "Review the attached image and route it to the vision-capable node.",
    "attachments": [
      {
        "path": "files/demo-workflow/wfexec-000123/attachments/screenshot.png",
        "mediaType": "image/png"
      }
    ]
  }
}
```

## Manager Control Plane Model

The redesign introduces a manager control plane distinct from mailbox transport.

### Separation of Concerns

- mailbox communication remains runtime-owned node-to-node transport
- manager send is a control-plane request from an `oyakata` manager tool session to the orchestration runtime
- a manager send may result in zero or more mailbox communications, node executions, retries, or planner-state updates

This separation avoids overloading a user- or manager-authored freeform message with the same meaning as a durable mailbox artifact.

### New Runtime Concepts

- `ManagerSession`
  - scoped to one `workflowExecutionId` and one manager node
  - represents the tool-call/control-plane identity for an active manager execution
- `ManagerMessage`
  - append-only command/request from the manager LLM/tool
  - carries audit text plus optional structured typed actions
- `ManagerDecision`
  - runtime-validated outcome of a manager message
  - may map to planner updates, node-start requests, communication replay, or explicit no-op / wait

### Identity and Scope

Manager send must be scope-bound:

- root manager may request root-scope actions and sub-workflow starts
- sub manager may request only actions within its owned sub-workflow
- worker nodes do not get manager-session credentials

Required ambient identity for LLM-triggered CLI use:

- `OYAKATA_GRAPHQL_ENDPOINT`
- `OYAKATA_MANAGER_AUTH_TOKEN`
- `OYAKATA_WORKFLOW_ID`
- `OYAKATA_WORKFLOW_EXECUTION_ID`
- `OYAKATA_MANAGER_NODE_ID`
- `OYAKATA_MANAGER_NODE_EXEC_ID`

The explicit command form requested by the user is supported:

```bash
oyakata gql "<graphql document>"
```

Resolution rules:

- workflow/domain identifiers are carried inside the GraphQL document variables/input
- manager node identity and authorization are resolved from ambient manager-session environment and validated against the presented bearer token
- local operator/debug mode may allow explicit overrides, but those are not part of the normal LLM-facing contract

### Manager Token Contract

- the runtime must mint a manager-session token when a manager node execution starts
- the token is scoped to one tuple:
  - `workflowExecutionId`
  - `managerSessionId`
  - `managerNodeId`
  - `managerNodeExecId`
- normal GraphQL HTTP transport uses `Authorization: Bearer <token>`
- `OYAKATA_MANAGER_AUTH_TOKEN` is the CLI/env injection path used inside manager tool environments, not a separate authentication mechanism
- the token must expire or be revoked when the manager step completes, fails, or is cancelled
- worker nodes must never inherit this token

## GraphQL Domain Schema

The exact SDL can evolve, but the canonical schema must support these domain operations.

### Queries

- `workflow(workflowName: String!): Workflow`
- `workflowExecution(workflowExecutionId: ID!): WorkflowExecution`
- `communications(input: CommunicationsQueryInput!): CommunicationConnection!`
- `communication(input: CommunicationLookupInput!): Communication`
- `nodeExecution(input: NodeExecutionLookupInput!): NodeExecution`
- `managerSession(input: ManagerSessionLookupInput!): ManagerSession`

### Mutations

- `executeWorkflow(input: ExecuteWorkflowInput!): ExecuteWorkflowPayload!`
- `resumeWorkflowExecution(input: ResumeWorkflowExecutionInput!): ResumeWorkflowExecutionPayload!`
- `rerunWorkflowExecution(input: RerunWorkflowExecutionInput!): RerunWorkflowExecutionPayload!`
- `sendManagerMessage(input: SendManagerMessageInput!): SendManagerMessagePayload!`
- `retryCommunicationDelivery(input: RetryCommunicationDeliveryInput!): RetryCommunicationDeliveryPayload!`
- `replayCommunication(input: ReplayCommunicationInput!): ReplayCommunicationPayload!`
- `cancelWorkflowExecution(input: CancelWorkflowExecutionInput!): CancelWorkflowExecutionPayload!`

### Optional Later Subscriptions

- `workflowExecutionEvents(workflowExecutionId: ID!): WorkflowExecutionEvent!`
- `managerSessionEvents(managerSessionId: ID!): ManagerSessionEvent!`

Subscriptions are intentionally deferred. Polling queries are acceptable in the first implementation.

## Timeout Inspection Fallback

If a runtime-controlled completion notification does not reach the expected manager step and the workflow times out or becomes stuck, operators and recovery logic still need a deterministic way to inspect the last known node result.

Primary inspection paths:

- GraphQL query path through `nodeExecution(input: NodeExecutionLookupInput!)`
- internal/library path through runtime session inspection helpers

### Required `nodeExecution` Query Fields

`nodeExecution` must expose enough data to debug timeout-or-missed-notification cases without requiring direct filesystem access.

Minimum required fields:

- identifiers:
  - `workflowId`
  - `workflowExecutionId`
  - `nodeId`
  - `nodeExecId`
- lifecycle:
  - `status`
  - `startedAt`
  - `endedAt`
  - `attempt`
  - `backendSessionId`
  - `backendSessionMode`
- artifacts:
  - `artifactDir`
  - `output`
  - `meta`
- diagnostics:
  - `terminalMessage`
  - `recentLogs[]`
  - `restartedFromNodeExecId`

Field semantics:

- `status` reports the node execution state such as `succeeded`, `failed`, `timed_out`, or `cancelled`
- `output` is the runtime-published `output.json` payload when available
- `meta` is the runtime-published `meta.json` content when available
- `terminalMessage` is the concise human-readable failure/timeout summary derived from runtime state or the latest terminal log entry
- `recentLogs[]` provides recent runtime log entries for the node execution, including timeout or adapter-failure messages

### Lookup Shape

Canonical lookup input should accept:

```text
workflowId + workflowExecutionId + nodeId + nodeExecId
```

The implementation may also support lookup by `(workflowExecutionId, nodeExecId)` when unambiguous, but the GraphQL contract should keep the fully scoped form.

### Internal Fallback Path

Before GraphQL is fully implemented, the runtime/library fallback path should remain available:

- load the workflow session by `workflowExecutionId`
- list runtime node executions for that session
- list runtime node logs for the relevant `nodeExecId`

This is the internal equivalent of the future `nodeExecution` GraphQL query and should be sufficient to answer:

- did the node actually finish?
- what status was recorded?
- was `output.json` published?
- what timeout/failure message was recorded?

## Communication Query Model

Communication inspection must be first-class.

### Lookup Keys

Canonical lookup input:

```text
workflowId + workflowExecutionId + communicationId
```

Even if `communicationId` is practically unique within a workflow execution, all three are accepted because that is the inspection shape requested by the user and it makes artifact resolution explicit.

### Returned Fields

`Communication` query responses must include:

- identifiers: `workflowId`, `workflowExecutionId`, `communicationId`
- sender/recipient: `fromNodeId`, `toNodeId`, `fromSubWorkflowId`, `toSubWorkflowId`
- lifecycle: `status`, `deliveryKind`, `routingScope`, `transitionWhen`
- provenance: `sourceNodeExecId`, `payloadRef`
- delivery bookkeeping: `deliveryAttemptIds`, `activeDeliveryAttemptId`
- timestamps: `createdAt`, `deliveredAt`, `consumedAt`
- artifact references: `artifactDir`
- mailbox artifact snapshots:
  - `message`
  - `meta`
  - `outboxMessage`
  - `outboxOutputRaw`
  - `inboxMessage`
  - `attempts[]`
- derived status summary:
  - communication lifecycle status
  - source node execution status
  - consumed-by node execution status when present

### Status Semantics

Communication lifecycle status stays distinct from node execution status:

- communication status: `created | delivered | consumed | delivery_failed | superseded`
- node execution status: `succeeded | failed | timed_out | cancelled`

The GraphQL layer must expose both explicitly and must not flatten them into one `success/fail` field.

## Communication Retry and Replay

The current mailbox design already distinguishes retry attempts from re-sends. The GraphQL redesign formalizes that distinction.

### Retry Delivery

Use when:

- the communication already exists,
- the send event is still the same,
- the failure was in delivery or recipient execution attempt,
- the historical communication artifact must remain the same logical send.

Effect:

- keep the same `communicationId`
- allocate a new `deliveryAttemptId`
- optionally allocate a new `agentSessionId`

### Replay Communication

Use when:

- an operator or manager wants to re-trigger the logical send after inspection,
- a prior send has already been consumed or must be superseded,
- the runtime wants a new durable send identity.

Effect:

- allocate a new `communicationId`
- mark the prior communication as `superseded` when applicable
- set the new communication `deliveryKind` to `manual-rerun`
- preserve `payloadRef` provenance back to the original source output or explicit replay source

This is aligned with the current mailbox rule that a re-executed/resubmitted send allocates a new `communicationId`.

## Manager Send Semantics

Manager control is submitted through GraphQL documents at the CLI surface, but the runtime must process the resulting mutation through structured rules.

### Input Shape

GraphQL mutation input:

```text
workflowId
workflowExecutionId
message?
actions?
attachments?
idempotencyKey?
managerSessionId?
managerNodeId?
managerNodeExecId?
```

`message` is operator/audit text. Execution-affecting requests must use typed `actions`.

Normal LLM/tool use omits the manager identity fields because they are resolved from ambient environment and auth context.

### Typed Action Envelope

The GraphQL mutation must accept a typed action list rather than relying on runtime interpretation of freeform prose for privileged operations.

Supported first-iteration action variants:

- `planner-note`
  - stores an informational note only
- `start-sub-workflow`
  - `{ subWorkflowId }`
- `deliver-to-child-input`
  - `{ inputNodeId }`
- `retry-node`
  - `{ nodeId }`
- `replay-communication`
  - `{ communicationId, reason? }`

Rules:

- `message` may be present without `actions` only for note/audit-only submissions
- execution-affecting requests must include at least one typed action
- the runtime must reject unknown action variants
- the runtime must reject a single manager execution that mixes typed GraphQL actions with payload-embedded `managerControl.actions`
- existing `managerControl.actions` validation/ownership rules remain the behavioral baseline for the GraphQL typed action variants

### Runtime Processing

1. Authenticate the manager session.
2. Resolve the active manager scope.
3. Persist the raw manager message into a manager-session log.
4. Validate the typed action envelope into one or more:
   - planner-only update,
   - child-start request,
   - child-input delivery request,
   - node retry request,
   - communication replay request,
   - informational/no-op note.
5. Validate ownership and workflow-structure constraints.
6. Materialize the approved action through existing runtime services.

Freeform `message` content may inform audit logs or planner notes, but must not be the only source of truth for execution-affecting authorization decisions.

### Relationship to Node Output Completion

GraphQL manager messaging is downstream of runtime-owned node completion; it is not the mechanism that discovers whether a worker finished.

Rules:

- the runtime must receive or await node completion in the node execution path itself
- accepted node output is published by the runtime before any follow-up manager message, mailbox send, or automatic transition is triggered
- if a completed node requires manager review, the runtime must start or queue that manager step directly from the execution transition
- the system must not depend on a periodic filesystem watcher that scans for new `output.json` files in order to wake the manager
- adapter-local file watching is allowed only as a special ingestion strategy for an external backend that can publish results solely through shared files; it must still hand the final result back into the normal runtime-owned completion path

### `communicationId` Allocation Rule

`communicationId` is always runtime-assigned.

- the client never supplies `communicationId` to `sendManagerMessage`
- if a manager message results only in planner-state updates or queue changes, no `communicationId` is allocated
- if a manager message materializes one or more mailbox sends, the runtime allocates one new `communicationId` per created send event
- fan-out therefore returns multiple created `communicationId` values
- a replay mutation allocates a new `communicationId`
- a delivery-retry mutation does not allocate a new `communicationId`; it allocates a new `deliveryAttemptId`

### Attachment Resolution Rule

When `sendManagerMessage` includes image or file attachments:

- attachments are represented as `DataDirFileRef`
- the runtime resolves them against `OYAKATA_ROOT_DATA_DIR`
- the resolved file must stay inside the configured data root
- node execution backends must receive the logical attachment content through runtime-prepared inputs, not by being given host absolute paths directly

### Output Shape

The send mutation must return:

- accepted/rejected result,
- parsed manager intent summary,
- created workflow actions,
- any created `communicationId` values,
- any queued node ids,
- any validation rejection reason.

### Idempotency Contract

- idempotency scope is `(mutationName, managerSessionId, idempotencyKey)`
- the runtime must persist:
  - the normalized request fingerprint
  - the original response payload
  - the first completion timestamp
- retrying the same mutation with the same key and the same normalized payload must return the original response without re-executing side effects
- retrying the same mutation with the same key but a different normalized payload must fail as a conflict
- `sendManagerMessage`, `replayCommunication`, and `retryCommunicationDelivery` must all support this behavior when `idempotencyKey` is provided

## Relationship to Existing `managerControl.actions`

### Compatibility Rule

Two manager-control input modes exist during migration:

1. `managerControl.actions` returned inside node output payload
2. explicit `sendManagerMessage` via `oyakata gql` control-plane command

### Priority Rule

For one manager execution, the runtime must treat the first used mode as authoritative:

- if a manager session emits control-plane GraphQL manager-message commands, those commands become the authoritative manager-control source for that execution
- if no control-plane commands are emitted, runtime may continue using `payload.managerControl.actions`
- if both modes are attempted in one manager execution, the runtime must fail that manager step rather than trying to merge them

This avoids contradictory dual control channels in one manager step.

### Long-Term Direction

GraphQL manager messaging becomes the primary control path for CLI-backed manager nodes.
Payload-embedded `managerControl.actions` remains a compatibility mechanism and a fallback for backends that cannot yet invoke tools/commands.

## CLI Redesign

### Canonical CLI Command

Canonical CLI command:

- `oyakata gql "<graphql document>"`

### Compatibility Commands

Existing commands remain initially:

- `workflow run`
- `session status`
- `session progress`
- `session resume`
- `session rerun`

But their implementation direction changes:

- they become optional convenience wrappers over the same GraphQL control plane
- transport/bootstrap flags may remain
- domain parameters should be modeled in GraphQL input objects first

### Local Serve Contract

`oyakata serve` continues to host the local control plane.

Added responsibilities:

- expose `/graphql`
- expose optional GraphQL schema/introspection in local development mode
- continue serving the current REST editor endpoints during migration
- make the browser UI migrate toward GraphQL queries/mutations in follow-up phases
- allow the generic `oyakata gql` CLI client to target the same local endpoint

## Data Model Extensions

The runtime session and mailbox record model needs additive fields for first-class replay and manager sessions.

### Communication Record Additions

Additive fields:

- `supersededByCommunicationId?: string`
- `supersededAt?: string`
- `replayedFromCommunicationId?: string`
- `managerMessageId?: string`

### Manager Session Record

New persisted concept:

- `managerSessionId`
- `workflowId`
- `workflowExecutionId`
- `managerNodeId`
- `managerNodeExecId`
- `status`
- `createdAt`
- `updatedAt`
- `lastMessageId`

### Manager Message Record

New persisted concept:

- `managerMessageId`
- `managerSessionId`
- `workflowId`
- `workflowExecutionId`
- `message`
- `parsedIntent`
- `accepted`
- `createdAt`

## Security and Safety

- manager auth must be scoped to one manager session, not to the entire server without boundaries
- worker nodes must not inherit manager-session credentials
- GraphQL mutations that can alter execution state must validate workflow ownership and manager scope
- communication replay must be idempotent under a caller-supplied idempotency key when available
- the local-first model remains the deployment assumption for this iteration

## Migration Plan Direction

Recommended migration order:

1. Add shared application services for communication inspection/retry/replay and manager messaging.
2. Add GraphQL schema and server integration on top of those services.
3. Add the generic `oyakata gql` CLI client.
4. Inject manager-session environment into manager-node executions and update manager prompt guidance.
5. Migrate browser UI execution/session APIs to GraphQL.

## Decision

The requested redesign is compatible with the current runtime design if GraphQL is treated as a new canonical control plane layered over the existing execution/mailbox engine.

It conflicts with the current CLI/control surface if interpreted as an in-place replacement with no abstraction step.

Therefore the redesign direction is:

- keep execution/mailbox/session artifacts,
- introduce a manager control plane,
- make GraphQL canonical,
- make CLI a generic client over that control plane,
- add first-class communication inspection and replay,
- support LLM-triggered `oyakata gql` through ambient manager-session context.
