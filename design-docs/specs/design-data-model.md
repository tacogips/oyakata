# Data Model Design

This document defines canonical data models for workflow files and internal runtime models.

## Overview

Goal: make workflow and node structures unambiguous and reviewable by humans before implementation.

Scope:
- File models (`workflow.json`, `node-{id}.json`, `workflow-vis.json`)
- Internal normalized models used by runtime
- Validation rules and review checklist

## File Data Models

### workflow.json

| Field | Type | Required | Notes |
|------|------|----------|-------|
| `workflowId` | string | Yes | Stable identifier |
| `description` | string | Yes | Human-readable purpose |
| `defaults.maxLoopIterations` | number | Yes | Initial default: `3` |
| `defaults.nodeTimeoutMs` | number | Yes | Initial default: `120000` |
| `nodes` | array of `WorkflowNodeRef` | Yes | Node definitions and references |
| `edges` | array of `WorkflowEdge` | Yes | Directed transitions |
| `branching.mode` | string | Yes | Must be `fan-out` |

`WorkflowNodeRef`:
- `id: string`
- `nodeFile: string` (expected format: `node-{id}.json`)
- `kind?: "task" | "branch-judge" | "loop-judge"`
- `completion?: CompletionRule` (optional for auto-complete nodes)

`WorkflowEdge`:
- `from: string`
- `to: string`
- `when: string` (expression name or `always`)
- `priority?: number` (optional metadata only; fan-out still applies)

### node-{id}.json

| Field | Type | Required | Notes |
|------|------|----------|-------|
| `id` | string | Yes | Must match workflow node id |
| `model` | string | Yes | `tacogips/codex-agent` or `tacogips/claude-code-agent` |
| `promptTemplate` | string | Yes | Render template |
| `variables` | object | Yes | Template bindings |
| `timeoutMs` | number | No | Overrides workflow default timeout |

### workflow-vis.json

| Field | Type | Required | Notes |
|------|------|----------|-------|
| `nodes` | array of `VisNode` | Yes | Per-node layout |
| `viewport` | object | No | Pan/zoom state |
| `uiMeta` | object | No | Non-runtime UI metadata |

`VisNode`:
- `id: string`
- `x: number`
- `y: number`

## Internal Runtime Models

These are normalized in memory after file loading and validation.

### WorkflowDefinition (normalized)

- `workflowId: string`
- `description: string`
- `defaults: RuntimeDefaults`
- `nodes: Map<NodeId, WorkflowNode>`
- `adjacency: Map<NodeId, WorkflowEdge[]>`
- `branchMode: "fan-out"`

### RuntimeDefaults

- `maxLoopIterations: number`
- `nodeTimeoutMs: number`

### WorkflowNode

- `id: NodeId`
- `kind: "task" | "branch-judge" | "loop-judge"`
- `model: "tacogips/codex-agent" | "tacogips/claude-code-agent"`
- `promptTemplate: string`
- `variables: Record<string, unknown>`
- `timeoutMs: number` (effective timeout after default merge)
- `completion: CompletionRule | null` (null means auto-complete)

### CompletionRule

- `type: "checklist" | "score-threshold" | "validator-result" | "none"`
- `config: object`

`type: "none"` or `completion: null` indicates no success judgment and auto-complete behavior.

### WorkflowEdge (normalized)

- `from: NodeId`
- `to: NodeId`
- `when: string`
- `priority: number | null`

## Model Invariants

- Every `workflow.json.nodes[].id` must be unique.
- Every `nodeFile` must exist in same workflow directory.
- `node-{id}.json.id` must match referenced workflow node id.
- Every edge endpoint must be declared in `nodes`.
- Branch mode is always fan-out.
- Effective timeout exists for every executable node (node override or default).
- Loop execution must be bounded (edge-local config or global default).

## Human Review Checklist

Before approving a workflow model:

1. Domain intent
- `description` clearly explains workflow goal and output expectation.

2. Graph correctness
- Start path exists.
- No unintended dead-end nodes.
- Fan-out branches are intentional and bounded downstream.

3. Node runtime quality
- `model` choice is appropriate for each node role.
- `promptTemplate` is understandable and deterministic.
- `variables` do not contain missing placeholders.

4. Safety controls
- Timeouts are realistic for each heavy node.
- Loop defaults and node-level overrides prevent runaway execution.

5. Completion semantics
- Nodes requiring quality gates define explicit `completion`.
- Auto-complete nodes are intentionally marked.

6. Visualization hygiene
- `workflow-vis.json` only contains UI state.
- No runtime behavior encoded in visualization metadata.

## Review Output Template

Use this concise format during human review:

- `Model`: Pass | Changes Required
- `Critical Issues`:
- `Ambiguous Fields`:
- `Safety Concerns`:
- `Approved Defaults`: `maxLoopIterations`, `nodeTimeoutMs`

## References

- `design-docs/specs/design-workflow-json.md`
- `design-docs/specs/architecture.md`
- `design-docs/specs/command.md`
