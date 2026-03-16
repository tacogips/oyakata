# oyakata

`oyakata` is a TypeScript project that manages writing sessions through cooperative multi-agent orchestration.

## Purpose

The system coordinates multiple agent execution backends and controls their collaboration with a JSON workflow definition.

Primary agent backends:
- `codex-agent`
- `claude-code-agent`

## Core Concept: Workflow (JSON)

A workflow is the execution contract for session management. It must represent:
- composition of multiple nodes
- branch conditions and branch-judge nodes
- loop conditions and loop-judge nodes
- branch bodies and loop bodies modeled as sub-workflow scopes when they span multiple nodes
- per-node completion conditions
- graph connectivity between nodes
- execution timeout policy (global default and per-node override)
- optional workflow-level prompt policy for `oyakata` and worker prompt composition

Runtime execution inputs for each executable node are separated into node files:
- `executionBackend`
- `model`
- `promptTemplate`
- optional `promptTemplateFile` for workflow-local `.md`/text prompt sources
- `variables`
- optional `output` contract:
  - `description`: human guidance for the expected business payload
  - `jsonSchema`: optional JSON Schema subset enforced by the runtime against the candidate payload
  - `maxValidationAttempts`: optional retry budget for malformed/schema-invalid candidate output
  - publication model: the LLM/backend proposes only the business JSON object; the runtime validates it, writes final `output.json`, and publishes mailbox output only after acceptance

## Workflow Directory Layout

Workflows are created under `.oyakata/` in subdirectories.

Example:

```text
.oyakata/
  writing-session/
    workflow.json
    workflow-vis.json
    node-draft.json
    node-review.json
```

Required files:
- `workflow.json`: workflow structure and metadata (must include `description` for workflow purpose; may include `prompts.oyakataPromptTemplate` and `prompts.workerSystemPromptTemplate`)
- `workflow-vis.json`: browser visualization state for vertical flow rendering (node `order`; `indent/color` are derived from graph semantics)
- `node-{id}.json`: executable node payload (`executionBackend`, `model`, `promptTemplate`, `variables`, optional `output` contract)
- prompt authoring recommendation: keep `workflow.json` / `node-{id}.json` in JSON, but store long prompt bodies in workflow-local files such as `prompts/<node-id>.md` and reference them with `promptTemplateFile`

Runtime boundary rule:
- root `oyakata` input and final workflow output are also exposed through mailbox artifacts, so external-to-root handoff uses the same mailbox model as parent/sub-workflow nesting

## Project Direction

Near-term purpose:

- `oyakata` exists to execute multi-agent workflows with high confidence.
- Workflow authors define node roles explicitly, for example `write code`, `review code`, `test`, and `re-review`.
- The system should guarantee that those roles are executed in the intended order or loop structure written in the workflow.
- That includes strict sequential execution and explicit repeated loops, for example "run this review/fix cycle at least 10 times".

Longer-term purpose:

- `oyakata` should eventually create new workflows by itself.
- It should then execute those workflows, inspect the results, and create the next workflow again.
- The long-term goal is a fully autonomous system that decides the next task by itself and eventually sets its own intermediate goals in service of a broader objective.

## Near-Term Execution Direction

The near-term execution model is intentionally simple:

- The `Oyakata Session Driver` keeps the main orchestration AI session.
- That manager session reads the workflow and decides which node to run next.
- Each node is treated as a simple worker that reads inbox/input context and writes outbox/output results, even if the node also edits code or other files in the workspace.
- The manager calls the next node through the `Call-Node API`, for example `oyakata call-node`.
- Workflow-order adherence is primarily a manager prompt responsibility rather than a separate runtime order-state machine.
- Timeout, semantic retry, deduplication, and similar policy decisions are owned by the active `Oyakata Session Driver` rather than by a separate runtime planner.
- The runtime still owns output validation and accepted artifact publication through the `Execution Dispatcher`, `Output Validator`, and `Mailbox Publisher`.
- The near-term direction does not introduce a separate `Runtime Arbiter` component.

Current implementation note:

- A first local `oyakata call-node <workflow-id> <workflow-run-id> <node-id>` path is now implemented for existing workflow sessions.
- That path already includes runtime-owned output validation and repair before accepted artifact publication.
- The current codebase still contains queue-based execution internals.
- The direction described below is the intended simplification target for the next iteration of the runtime model.

## Near-Term Components

- `Workflow Definition`: the JSON workflow that defines node roles, ordering, loops, and conditions
- `Workflow Run`: one end-to-end execution of a workflow
- `Oyakata Session Driver`: the long-lived orchestration AI session for a workflow run
- `Call-Node API`: the dedicated command or API used by the manager to invoke a node
- `Execution Dispatcher`: runtime-side lifecycle owner for one node call
- `Node Adapter`: backend bridge such as `codex-agent` or `claude-code-agent`
- `Output Validator`: runtime-side contract validation for candidate node output
- `Mailbox Publisher`: runtime-side publication of accepted output artifacts
- `Node Inbox`: the persisted input/inbox payload the node reads from
- `Node Outbox`: the persisted output payload the node writes to
- `Artifact Store`: runtime-owned `input.json`, accepted `output.json`, `meta.json`, validation-attempt artifacts, and related execution artifacts
- `Runtime DB Index`: optional query/index layer; file artifacts remain source of truth

## Near-Term Sequence

The sequence below shows the intended manager-driven flow for the next simplified execution model.

```mermaid
sequenceDiagram
    autonumber
    actor U as User / Caller
    participant W as Workflow Definition
    participant O as Oyakata Session Driver
    participant C as Call-Node API
    participant E as Execution Dispatcher
    participant A as Node Adapter
    participant N as Worker Node Session
    participant V as Output Validator
    participant M as Mailbox Publisher
    participant D as Runtime DB Index

    U->>O: start workflow with purpose / human input
    O->>W: read workflow structure and current run state

    loop until workflow completes
        O->>O: decide next node from workflow order, loop rules, and prior outputs
        O->>C: call-node(workflowId, workflowRunId, nodeId, inbox message)
        C->>E: authenticate manager scope and dispatch node call

        loop until output accepted or retry budget exhausted
            E->>A: execute or resume node session
            A->>N: run node
            N-->>A: candidate output
            A-->>E: candidate output
            E->>V: validate candidate output

            alt output valid
                V-->>E: accepted
                E->>M: publish accepted output artifacts
                M->>D: index execution(best effort)
                M-->>E: output refs and published result
            else output invalid and retry remains
                V-->>E: validation errors
                E->>A: continue same node session with repair request
            else output invalid and retry exhausted
                V-->>E: terminal validation failure
            end
        end

        E-->>C: accepted output summary or failure
        C-->>O: return output summary, refs, and status
        O->>O: decide continue / retry / next node / loop exit
    end

    O-->>U: final workflow result
```

## Deterministic Mock Workflow Example

This repository now includes a ready-to-run deterministic example:

- `.oyakata/software-auto-pipeline/workflow.json`
- `.oyakata/software-auto-pipeline/workflow-vis.json`
- `.oyakata/software-auto-pipeline/node-*.json`
- `.oyakata/software-auto-pipeline/mock-scenario.json`

The workflow covers:
- design
- design discussion
- implementation
- security check
- code review
- test
- test review

`mock-scenario.json` pins deterministic per-node outputs for the CLI execution backends.
The sample `test-review` node returns `needs_rework` on first execution and `approved` on second execution to demonstrate looped rework.

Run example:

```bash
bun run src/main.ts workflow run software-auto-pipeline \
  --workflow-root ./.oyakata \
  --mock-scenario ./.oyakata/software-auto-pipeline/mock-scenario.json \
  --output json
```

Progress / resume / rerun commands:

```bash
# Pause after a few steps
bun run src/main.ts workflow run software-auto-pipeline --workflow-root ./.oyakata --max-steps 3 --output json

# Inspect progress
bun run src/main.ts session progress <session-id> --output json

# Resume paused session
bun run src/main.ts session resume <session-id>

# Re-run from a specific node (creates a new session)
bun run src/main.ts session rerun <session-id> implement --output json
```

## Git Policy

Default policy for version control:
- Track workflow definitions in Git:
  - `.oyakata/<workflow-name>/workflow.json`
  - `.oyakata/<workflow-name>/workflow-vis.json`
  - `.oyakata/<workflow-name>/node-*.json`
- Do not track runtime execution outputs in Git:
  - `{artifact-root}/{workflow_id}/executions/{workflowExecutionId}/nodes/{node}/{node-exec-id}/input.json`
  - `{artifact-root}/{workflow_id}/executions/{workflowExecutionId}/nodes/{node}/{node-exec-id}/output.json`
  - `{artifact-root}/{workflow_id}/executions/{workflowExecutionId}/nodes/{node}/{node-exec-id}/meta.json`
  - dynamic session/progress files under `.oyakata-datas/`

Default runtime paths:
- persistent artifact root: `.oyakata-datas/workflow/`
- dynamic operational state root: `.oyakata-datas/` (for example session store files)
- runtime SQLite index: `.oyakata-datas/oyakata.db`

The repository `.gitignore` enforces this for `.oyakata-datas/`.
If you use a custom `--artifact-root` or `OYAKATA_ARTIFACT_ROOT`, add that path to your local/project ignore rules.

Runtime SQLite behavior:
- File artifacts remain source-of-truth for full node payload files.
- SQLite stores queryable runtime index data for:
  - session snapshots
  - node input/output hashes and payload JSON
  - node execution logs

## Interfaces

- Direct node call: `oyakata call-node <workflow-id> <workflow-run-id> <node-id> [--message-json <json> | --message-file <path>]`
  - Local-only in the current implementation.
  - Loads an existing workflow session, executes one node directly, validates candidate output, retries invalid output in the same node session when possible, and publishes accepted artifacts.
- TUI: `oyakata tui [workflow-name] [--workflow <name>] [--resume-session <session-id>]`
  - Interactive terminal: select workflow (if omitted), input prompt, execute, and watch per-node progress.
  - Non-interactive terminal: promptless fallback mode is used; `workflow-name` is required.
  - Resume: `--resume-session` resumes an existing session directly.
- Web UI: `oyakata serve`, then open `http://127.0.0.1:43173/`
  - Choose workflow, input prompt, start async execution, and watch session/node progress by polling the GraphQL control plane.
  - The served browser app uses `/graphql` for workflow-definition, execution, and session flows. The only remaining `/api/*` browser bootstrap endpoint is `/api/ui-config`.
- GraphQL control plane: `oyakata gql "<graphql-document>"`
  - Sends GraphQL requests to `http://127.0.0.1:43173/graphql` by default.
  - Uses `--variables '{"key":"value"}'` or `--variables @vars.json` for GraphQL variables.
  - Uses `OYAKATA_MANAGER_AUTH_TOKEN` automatically for bearer auth unless `--auth-token` or `--auth-token-env` overrides it.
  - For manager-scoped calls, forwards `OYAKATA_MANAGER_SESSION_ID` to `/graphql` so manager mutations can omit `managerSessionId` from the GraphQL input.
  - The HTTP server does not inherit manager auth or scope from its own ambient `OYAKATA_MANAGER_*` environment; manager-scoped HTTP calls must supply transport metadata explicitly.
  - The HTTP server also does not trust in-process auth/session fallback fields for `/graphql`; only the request `Authorization` header and `X-Oyakata-Manager-Session-Id` header can establish manager scope there.

Example:

```bash
bun run src/main.ts gql \
  'query ($workflowName: String!) { workflow(workflowName: $workflowName) { workflowId managerNodeId } }' \
  --variables '{"workflowName":"software-auto-pipeline"}' \
  --output json
```

Workflow execution overview by run ID:

```bash
bun run src/main.ts gql \
  'query ($workflowExecutionId: String!) { workflowExecutionOverview(workflowExecutionId: $workflowExecutionId, firstCommunications: 50, recentLogLimit: 10) { workflowExecutionId workflowId workflowName status nodes { nodeId nodeExecId backendSessionId backendSessionMode output } communications { totalCount items { record { communicationId fromNodeId toNodeId status } artifactSnapshot { outboxOutputRaw inboxMessageJson } } } } }' \
  --variables '{"workflowExecutionId":"sess-20260315T000000Z-example"}' \
  --output json
```

Frontend verification:
- The browser frontend lives under `ui/` and is verified separately from the root TypeScript program.
- The current checked-in frontend is SolidJS.
- `bun run ui:framework` reports the active checked-in frontend entrypoint and any local workspace blockers for the verified UI toolchain.
- `bun run typecheck:ui` detects the active frontend entrypoint and runs the matching framework-aware verification path.
- `bun run test:ui` runs UI unit tests non-interactively through Vitest and does not rely on the interactive Vitest UI server.
- `bun run test:ui:interactive` is the opt-in interactive Vitest UI path and uses the same repository-local Node/package guards as the other UI tooling commands.
- Run `bun run check:ui` for the UI typecheck plus bundle verification.
- Run `bun run typecheck` to verify both server and UI projects together.
- `bun run build:ui` now emits `ui/dist/frontend-mode.json` so `/api/ui-config` reports the frontend contract of the actually served assets instead of inferring it only from source entrypoints.
- Repository UI tooling commands resolve the package root from their checked-in script location rather than the caller's current working directory, so framework detection, `package.json`, and `node_modules` stay aligned.

## Library API

`oyakata` can be called as a library from external applications.

Primary exports from `src/lib.ts`:
- `inspectWorkflow(workflowName, options)`
- `executeWorkflow({ workflowName, ...options })`
- `resumeWorkflow({ sessionId, ...options })` (`sessionId` is the current public API name for workflow-run scope; design docs call this `workflowExecutionId`)
- `rerunWorkflow({ sourceSessionId, fromNodeId, ...options })` (`sourceSessionId` is the current public API compatibility name for prior `workflowExecutionId`)
- `getSession(sessionId, options)` (`sessionId` compatibility alias for `workflowExecutionId`)
- `listSessions(options)` (runtime SQLite-backed summaries)
- `getRuntimeSessionView(sessionId, options)` (session + node executions + node logs; `sessionId` is workflow-run scope)
- low-level exports: `runWorkflow`, `runCli`, `startServe`, `handleApiRequest`, `loadWorkflowFromDisk`

Minimal example:

```ts
import { executeWorkflow, getRuntimeSessionView } from "oyakata";

const run = await executeWorkflow({
  workflowName: "software-auto-pipeline",
  workflowRoot: "./.oyakata",
  artifactRoot: "./.oyakata-datas/workflow",
  runtimeVariables: { prompt: "Implement feature X" },
});

const runtime = await getRuntimeSessionView(run.sessionId, { cwd: process.cwd() });
console.log(runtime.session.status, runtime.nodeExecutions.length, runtime.nodeLogs.length);
```

`workflow.json` represents control-flow only:
- graph connectivity between nodes
- completion criteria
- branch/loop expressions and routing
- structural block typing for canonical branch-block and loop-body sub-workflows
- workflow defaults (global loop limit and default node timeout)
- references to each `node-{id}.json`

Branch behavior:
- when multiple branch conditions match, all matched branches execute (fan-out)
- when a branch body spans multiple nodes, the canonical pattern is a `subWorkflow` with `block.type = "branch-block"` entered from a `branch-judge` edge to that sub-workflow manager

Loop behavior:
- loop-local limits may be omitted and then use workflow-level global default
- when a loop body spans multiple nodes, the canonical pattern is a `subWorkflow` with `block.type = "loop-body"` and a matching `loops[].id`; the loop `continueWhen` edge should re-enter the loop-body manager

Completion behavior:
- completion can be optional for some nodes (auto-complete / no-success-judgment nodes)

Initial defaults:
- `defaults.maxLoopIterations = 3`
- `defaults.nodeTimeoutMs = 120000`

## Design Documents

- `design-docs/specs/architecture.md`
- `design-docs/specs/command.md`
- `design-docs/specs/notes.md`
- `design-docs/specs/design-workflow-json.md`
- `design-docs/specs/design-data-model.md`
- `design-docs/specs/design-tui.md`
- `design-docs/qa.md`

## Development Environment

- Runtime: Bun
- Language: TypeScript (strict mode)
- Environment: Nix flakes + direnv
