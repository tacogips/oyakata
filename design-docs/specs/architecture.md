# Architecture Design

This document defines the architecture for cooperative multi-agent workflow execution.

## Overview

`oyakata` manages writing sessions by executing JSON-defined workflows across multiple agent backends, primarily:
- `tacogips/codex-agent`
- `tacogips/claude-code-agent`

The architecture focuses on deterministic orchestration, explicit completion conditions, and controlled branching/looping.

## System Context

Inputs:
- Workflow directory under `<workflow-root>/<workflow-name>/` (default `./.oyakata`)
- Session metadata
- Runtime variables for prompt rendering

Outputs:
- Session artifacts (drafts, reviews, decisions)
- Node execution logs and completion status
- Branch/loop trace for reproducibility

## Core Components

1. Workflow Loader
- Loads `workflow.json`
- Resolves referenced `node-{id}.json`
- Validates schema and node file integrity

2. Workflow Visualization State Manager
- Loads/saves `workflow-vis.json`
- Preserves browser-edited node layout (e.g., `x`, `y`, `width`, `height`)
- Keeps visualization state separate from runtime control logic

3. Prompt Renderer
- Resolves `promptTemplate` with `variables`
- Produces provider-ready prompt payloads

4. Agent Adapter Layer
- Maps `model` in node to backend implementation
- Initial targets: `tacogips/codex-agent`, `tacogips/claude-code-agent`

5. Execution Engine
- Traverses workflow graph
- Expands and executes node sequences defined as sub-workflows
- Evaluates completion conditions
- Applies branch rules (including branch-judge node results)
- Enforces loop limits (including loop-judge node results)
- Applies fan-out transitions when multiple branch conditions match
- Enforces node execution timeout (node override or workflow default)

6. Session State Store
- Persists per-node input/output
- Tracks completion evidence
- Stores transition history
- Writes node execution artifacts to `{artifact-root}/{workflow_id}/{node}/{node-exec-id}/`

7. Local HTTP Server (`oyakata serve`)
- Hosts browser UI (Svelte) and local API on one process
- Supports workflow listing/loading/saving/validation
- Supports workflow execution start/observe/cancel
- Restricts by default to local interface (`127.0.0.1`)

8. Browser Workflow Editor (Svelte)
- Visual graph editing for nodes, edges, branch/loop rules, and defaults
- SVG-based canvas interaction for drag, pan/zoom, and edge drawing
- Node payload editing (`model`, `promptTemplate`, `variables`, `timeoutMs`)
- Layout editing persisted to `workflow-vis.json`
- Run controls and execution trace view for local sessions

9. TUI Runtime (Bun + `neo-blessed`)
- Full-screen terminal workflow selector and execution console
- Supports node-by-node execution visibility and log streaming
- Supports interactive user input collection for human-input nodes
- Invokes the same execution engine and artifact contract as CLI/serve paths

## Workflow Execution Model

### Workflow Directory Contract

Each workflow exists in its own directory under `<workflow-root>`:

- `<workflow-root>/<workflow-name>/workflow.json`
- `<workflow-root>/<workflow-name>/workflow-vis.json`
- `<workflow-root>/<workflow-name>/node-{id}.json` (one per executable node)

`workflow.json` must contain `description` to state the workflow objective.

Workflow root resolution:
1. CLI `--workflow-root`
2. `OYAKATA_WORKFLOW_ROOT`
3. `./.oyakata` (default)

### Node Execution Artifact Contract

Each node execution must persist artifacts under:
- `{artifact-root}/{workflow_id}/{node}/{node-exec-id}/`

Where:
- `{artifact-root}` resolution order:
  1. CLI `--artifact-root`
  2. `OYAKATA_ARTIFACT_ROOT`
  3. `./.oyakata/workflow` (default)
- `{workflow_id}` is `workflow.json.workflowId`.
- `{node}` is the workflow node id.
- `{node-exec-id}` is a unique execution id for that node run.

Required artifact files per execution:
- `input.json`: fully resolved runtime input passed to the node
- `output.json`: node execution output payload
- `meta.json`: execution metadata (timestamps, status, model, timeout result)

`oyakata` manager node responsibilities for chaining:
- read `output.json` from prior node execution artifacts
- resolve and compose next-node input payload
- persist composed input to next node `input.json` before execution

When a downstream input source is `human-input`, the manager requests input through the active UI channel:
- TUI mode: modal/input pane in terminal UI
- non-TUI mode: CLI prompt or API-provided input payload

### Hierarchical Workflow Model

Node sequences may be represented as reusable `sub-workflow` units.

Rules:
- A sub-workflow must include exactly one `input` node and one `output` node.
- Sub-workflow `input` may receive data from:
  - direct human input
  - another workflow output
  - another node output
  - another sub-workflow output
- A workflow must contain exactly one `oyakata` manager node.
- The `oyakata` manager node is responsible for:
  - selecting and triggering sub-workflow execution
  - resolving input bindings into each sub-workflow `input` node
  - collecting each sub-workflow `output` node result for downstream routing
  - routing messages between sub-workflows during conversation sessions
  - mapping execution artifact outputs to downstream node inputs

### Inter-Sub-Workflow Conversation

Two or more sub-workflows may exchange messages as a managed conversation.

Rules:
- Sub-workflows do not communicate directly; all messages are routed by the `oyakata` manager node.
- Conversation participants are declared in workflow configuration.
- Each conversation enforces termination controls:
  - max turn count
  - explicit stop condition
- Routed messages are persisted in session state as an ordered transcript.
- Conversation orchestration policy may enforce:
  - turn-taking strategy
  - role memory scope/window
  - role-level tool permissions
  - convergence thresholds
  - parallel branch and merge behavior
  - token/cost budget caps

Deterministic handoff contract:
- `oyakata` routes messages using explicit `OutputRef` metadata.
- `OutputRef` must include at least: `sessionId`, `workflowId`, `subWorkflowId`, `outputNodeId`, `nodeExecId`, `artifactDir`.
- Downstream consumers resolve input from `OutputRef` instead of implicit "latest output" behavior.
- If an explicit `nodeExecId` is not provided in config, selection policy must be declared (`latest-succeeded`, `latest-any`, or `by-loop-iteration`).

VCS checkpoint contract:
- Each node execution artifact directory additionally writes `handoff.json` and `commit-message.txt`.
- `handoff.json` includes stable `outputRef` and `sha256` hashes for input/output payloads.
- `input.json` includes `upstreamOutputRefs` so downstream input provenance is explicit.
- `commit-message.txt` provides a machine-friendly metadata template for Git/JJ checkpoints.
- Detailed format is defined in `design-docs/specs/design-vcs-handoff-checkpoints.md`.

### Node Model

Execution node payload is externalized in `node-{id}.json`:
- `model`: backend identifier
- `promptTemplate`: template text
- `variables`: runtime bindings
- optional `argumentsTemplate`: structured argument skeleton
- optional `argumentBindings`: deterministic mapping rules from runtime sources to `argumentsTemplate`
- optional `templateEngine`: rendering engine for prompt text (default: `mustache`)

Node input injection policy:
- For skill/tool adapters that accept `ARGUMENTS` only, `oyakata` must pass assembled `arguments` object.
- Complex data composition must be done via `argumentBindings` and source references, not logic-heavy template syntax.
- Keep template engine intentionally simple for prompt text rendering; avoid full Handlebars-style execution semantics in core runtime.

`workflow.json` contains structural information:
- node set and connectivity
- completion criteria
- branch/loop conditions
- workflow defaults (`maxLoopIterations`, `nodeTimeoutMs`)
- references to node payload files

### Connectivity

Edges define control flow:
- unconditional transitions
- conditional branching (`when` expression)
- loop-back edges for retries/iterations

### Completion Conditions

A node may define explicit completion criteria, such as:
- checklist satisfaction
- score threshold
- validator pass/fail

If completion is omitted, or `completion.type = "none"`, the node is treated as auto-complete after successful execution.
The engine does not advance until completion is met (or auto-complete is accepted) or a terminal failure path is selected.

Sub-workflow execution is complete when its `output` node completes and returns an output payload to the `oyakata` manager node.

### Branching

Branching uses evaluated conditions over:
- node output
- branch-judge node output
- session state

All matching branches should be selected (fan-out).

### Looping

Looping is allowed via backward edges and must include safeguards:
- max iteration count per loop
- loop timeout or retry budget
- fallback branch on exhaustion
- loop-judge node based continuation/termination

If loop-local limits are omitted, workflow-level global defaults are applied.

### Reference Pattern: Multi-Subgroup Hardening Loop

A representative execution pattern is:
- `oyakata` manager receives user implementation instruction.
- Implementation node produces initial change set.
- `subgroup1` executes anti-pattern review -> counter-opinion -> mediation -> implementation fix -> commit.
- `subgroup2` executes security review -> rebuttal -> mediation -> implementation fix.
- `subgroup3` validates test integrity.
- `subgroup4` closes the round and passes control to loop-judge.
- Loop-judge either:
  - continues from implementation node, or
  - exits when round objective is satisfied.

Recommended bound for this pattern is `maxIterations = 3`.

### Reference Pattern: Adversarial Debate Loop

A second representative execution pattern is:
- `oyakata` manager starts with user instruction.
- `blackhat` node attempts penetration and records findings.
- commit checkpoint is executed.
- `whitehat` node proposes/implements defense.
- commit checkpoint is executed.
- `blackhat` attempts re-penetration against new defenses.
- `mediation` node decides whether unresolved issues remain.
- loop-judge either continues another round or terminates when:
  - major issues are exhausted, or
  - maximum rounds are reached.

This architecture pattern also applies to non-security domains by replacing role semantics (for example challenger/defender/mediator in web app design refinement).

### Timeout

Node execution supports timeout configuration:
- node-level timeout via `node-{id}.json.timeoutMs`
- fallback to `workflow.json.defaults.nodeTimeoutMs`

Timeout events are treated as explicit execution results for downstream routing.

## HTTP/API Runtime Model (Serve Mode)

`oyakata serve` runs a local web application and API for editing/execution.

Primary API groups:
- `GET /api/workflows`: list available `<workflow-root>/*` workflows
- `GET /api/workflows/:name`: load normalized workflow + node payloads + vis state
- `PUT /api/workflows/:name`: save workflow changes to file set
- `POST /api/workflows/:name/validate`: run structural and semantic validation
- `POST /api/workflows/:name/execute`: start execution session
- `GET /api/sessions/:id`: poll current execution state
- `POST /api/sessions/:id/cancel`: request cancellation

Design constraints:
- File writes must be atomic (temp file + rename) to avoid JSON corruption.
- Concurrent edits are conflict-protected via revision token or last-write detection.
- Execution API reuses the same engine as CLI run path.

## TUI Runtime Model

`oyakata tui` runs a local terminal UI application (Bun runtime) for selection and execution.

Core screens:
- Workflow selector: list workflows discovered under `<workflow-root>`
- Execution view: current node, status, loop counters, branch decisions, recent logs
- Input prompt: capture user responses for `human-input` nodes
- Artifact trace: quick view of current execution artifact paths

Design constraints:
- TUI must be non-destructive and keyboard-first.
- TUI must handle terminal resize without losing execution context.
- TUI must degrade to plain prompt mode when interactive terminal capabilities are unavailable.

## UI/Execution Separation

The browser editor is a control surface only:
- UI state and drag layout are saved in `workflow-vis.json`.
- Runtime control data remains in `workflow.json` and `node-{id}.json`.
- Execution records remain session artifacts; no runtime state is persisted in visualization file.

## Non-Goals (Current Scope)

- Distributed multi-host scheduling
- Fully generic plugin marketplace

## Related Detail Document

See `design-docs/specs/design-workflow-json.md` for the JSON model design.
See `design-docs/specs/design-data-model.md` for canonical file/runtime data models and human review checklist.
See `design-docs/specs/design-tui.md` for TUI framework selection and interaction design.
