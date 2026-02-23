# Workflow JSON Design

This document defines the JSON model for workflow orchestration and the required file layout.

## Overview

Workflow orchestration is split into multiple files under `.oyakata/<workflow-name>/` with explicit completion, branching, and loop semantics.

## Workflow Directory Structure

Required files per workflow:
- `workflow.json`
- `workflow-vis.json`
- `node-{id}.json` (one file per executable node)

Example:

```text
.oyakata/
  writing-session/
    workflow.json
    workflow-vis.json
    node-draft.json
    node-review.json
```

## workflow.json

`workflow.json` holds structural and control-flow definitions and must include:
- `description`: purpose of the workflow
- node graph and connectivity
- completion conditions
- branch definitions (including branch-judge node references)
- loop definitions (including loop-judge node references)
- global defaults (including loop limit and node timeout)
- references to `node-{id}.json`

Initial default values:
- `defaults.maxLoopIterations = 3`
- `defaults.nodeTimeoutMs = 120000`

Conceptual example:

```json
{
  "workflowId": "writing-session",
  "description": "Draft and review a document cooperatively.",
  "defaults": {
    "maxLoopIterations": 3,
    "nodeTimeoutMs": 120000
  },
  "nodes": [
    {
      "id": "draft",
      "nodeFile": "node-draft.json",
      "completion": {
        "type": "checklist",
        "required": ["draft_created"]
      }
    },
    {
      "id": "branch-check",
      "kind": "branch-judge",
      "nodeFile": "node-branch-check.json",
      "completion": {
        "type": "validator-result"
      }
    }
  ],
  "edges": [
    { "from": "draft", "to": "branch-check", "when": "always" },
    { "from": "branch-check", "to": "review", "when": "needs_review" },
    { "from": "branch-check", "to": "done", "when": "skip_review" }
  ],
  "branching": {
    "mode": "fan-out"
  }
}
```

## node-{id}.json

Each `node-{id}.json` contains execution payload used at runtime:
- `model` (`tacogips/codex-agent` or `tacogips/claude-code-agent`)
- `promptTemplate`
- `variables`
- optional `timeoutMs` (node execution timeout override)

Example:

```json
{
  "id": "draft",
  "model": "tacogips/codex-agent",
  "timeoutMs": 90000,
  "promptTemplate": "Write draft for {{topic}}",
  "variables": {
    "topic": "workflow design"
  }
}
```

## workflow-vis.json

`workflow-vis.json` contains browser visualization state only, for example:
- node positions (`x`, `y`)
- pan/zoom
- optional UI grouping metadata

This file is updated by browser-side operations and should not define runtime execution semantics.

## Branching and Loop Semantics

- Branch definitions include branch condition and the branch-judge node used for evaluation.
- Loop definitions include loop condition and the loop-judge node used for continuation/termination.
- Workflow must represent both as explicit graph/control-flow elements.
- Branch matching behavior uses fan-out: all matching outbound branches are executed.

## Loop Semantics

Looping is represented by edges that target an upstream node.

Loop controls:
- `maxIterations` per loop path (optional if global default exists)
- optional backoff policy
- fallback edge when loop budget is exhausted

If loop-specific limits are omitted, `workflow.json.defaults.maxLoopIterations` is applied.

## Completion Semantics

Completion block determines whether node execution is accepted.

Supported conceptual strategies:
- `checklist`
- `score-threshold`
- `validator-result`
- `none` (no success judgment; node is treated as auto-complete after successful execution)

Completion result drives transition decisions.

## Timeout Semantics

- Each node may define `timeoutMs` in `node-{id}.json`.
- If omitted, `workflow.json.defaults.nodeTimeoutMs` is used.
- Timeout expiration should produce a timeout-specific failure result for routing/handling.

## Validation Rules (Conceptual)

- Workflow must be located under `.oyakata/<workflow-name>/`.
- `workflow.json` must include `description`.
- Node ids must be unique.
- All edge endpoints must exist.
- Every executable node must have a valid `node-{id}.json`.
- `workflow-vis.json` must be treated as visualization state only.
- Looping paths must be bounded by loop-local limits or global default.
- Completion block may be omitted when node is configured as auto-complete or `completion.type = "none"`.

## References

- `design-docs/specs/architecture.md`
- `design-docs/specs/command.md`
- `design-docs/specs/design-data-model.md`
