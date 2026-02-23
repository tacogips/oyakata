# Architecture Design

This document defines the architecture for cooperative multi-agent workflow execution.

## Overview

`oyakata` manages writing sessions by executing JSON-defined workflows across multiple agent backends, primarily:
- `tacogips/codex-agent`
- `tacogips/claude-code-agent`

The architecture focuses on deterministic orchestration, explicit completion conditions, and controlled branching/looping.

## System Context

Inputs:
- Workflow directory under `.oyakata/<workflow-name>/`
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
- Preserves browser-edited node positions (e.g., `x`, `y`)
- Keeps visualization state separate from runtime control logic

3. Prompt Renderer
- Resolves `promptTemplate` with `variables`
- Produces provider-ready prompt payloads

4. Agent Adapter Layer
- Maps `model` in node to backend implementation
- Initial targets: `tacogips/codex-agent`, `tacogips/claude-code-agent`

5. Execution Engine
- Traverses workflow graph
- Evaluates completion conditions
- Applies branch rules (including branch-judge node results)
- Enforces loop limits (including loop-judge node results)
- Applies fan-out transitions when multiple branch conditions match
- Enforces node execution timeout (node override or workflow default)

6. Session State Store
- Persists per-node input/output
- Tracks completion evidence
- Stores transition history

## Workflow Execution Model

### Workflow Directory Contract

Each workflow exists in its own directory under `.oyakata/`:

- `.oyakata/<workflow-name>/workflow.json`
- `.oyakata/<workflow-name>/workflow-vis.json`
- `.oyakata/<workflow-name>/node-{id}.json` (one per executable node)

`workflow.json` must contain `description` to state the workflow objective.

### Node Model

Execution node payload is externalized in `node-{id}.json`:
- `model`: backend identifier
- `promptTemplate`: template text
- `variables`: runtime bindings

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

A node must define explicit completion criteria, such as:
- checklist satisfaction
- score threshold
- validator pass/fail

The engine does not advance until completion is met or a terminal failure path is selected.

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

### Timeout

Node execution supports timeout configuration:
- node-level timeout via `node-{id}.json.timeoutMs`
- fallback to `workflow.json.defaults.nodeTimeoutMs`

Timeout events are treated as explicit execution results for downstream routing.

## Non-Goals (Current Scope)

- UI-level workflow editing
- Distributed multi-host scheduling
- Fully generic plugin marketplace

## Related Detail Document

See `design-docs/specs/design-workflow-json.md` for the JSON model design.
See `design-docs/specs/design-data-model.md` for canonical file/runtime data models and human review checklist.
