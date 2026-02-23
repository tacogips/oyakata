# Design Notes

This document captures additional design notes for cooperative multi-agent orchestration.

## Overview

The project uses workflow-driven coordination where agent behavior is explicit and auditable.

## Notable Decisions

### Primary Agent Providers

Initial design scope includes exactly two model targets:
- `tacogips/codex-agent`
- `tacogips/claude-code-agent`

### Prompt Decomposition

Prompt payloads are separated into:
- `promptTemplate`: reusable template
- `variables`: runtime-resolved data

This enables deterministic replay and easier session debugging.

Additional input assembly policy:
- Keep prompt rendering simple (`mustache`-style substitution).
- Build complex runtime payloads as structured `arguments` via explicit bindings.
- Avoid logic-heavy template engines (for example full Handlebars helper flow) in core runtime paths.

### Workflow File Split

Workflow data is intentionally split:
- `workflow.json`: structure/control and workflow `description`
- `node-{id}.json`: runtime payload (`model`, `promptTemplate`, `variables`)
- `workflow-vis.json`: browser visualization state (`x`, `y`, `width`, `height`, etc.)

This avoids coupling runtime semantics with browser UI state.

### Deterministic Control Flow

Workflow JSON must make control flow explicit:
- graph edges for transitions
- branch conditions
- loop policies and loop-judge nodes

Implicit transitions are avoided.

### Confirmed Runtime Policies

- Branch behavior: fan-out to all matched branches.
- Loop limit fallback: use workflow global default when loop-local limit is omitted.
- Completion: auto-complete nodes are allowed; success-judgment-free nodes can be configured.
- Timeout: each node can define execution timeout, with workflow-level default fallback.
- Conversation handoff: `oyakata` routes by explicit `OutputRef` (`sessionId`, `subWorkflowId`, `outputNodeId`, `nodeExecId`) instead of implicit latest-output inference.

### Completion-First Progression

A node should not transition until completion criteria are evaluated.
This supports quality gates in collaborative writing workflows.

### Open Items

See `design-docs/qa.md` for current decision status and any remaining confirmation items.
