# oyakata

`oyakata` is a TypeScript project that manages writing sessions through cooperative multi-agent orchestration.

## Purpose

The system coordinates multiple agent backends and controls their collaboration with a JSON workflow definition.

Primary agent backends:
- `tacogips/codex-agent`
- `tacogips/claude-code-agent`

## Core Concept: Workflow (JSON)

A workflow is the execution contract for session management. It must represent:
- composition of multiple nodes
- branch conditions and branch-judge nodes
- loop conditions and loop-judge nodes
- per-node completion conditions
- graph connectivity between nodes
- execution timeout policy (global default and per-node override)

Runtime execution inputs for each executable node are separated into node files:
- `model`
- `promptTemplate`
- `variables`

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
- `workflow.json`: workflow structure and metadata (must include `description` for workflow purpose)
- `workflow-vis.json`: browser visualization state (e.g., node `x`,`y`) and updated by browser operations
- `node-{id}.json`: executable node payload (`model`, `promptTemplate`, `variables`)

`workflow.json` represents control-flow only:
- graph connectivity between nodes
- completion criteria
- branch/loop expressions and routing
- workflow defaults (global loop limit and default node timeout)
- references to each `node-{id}.json`

Branch behavior:
- when multiple branch conditions match, all matched branches execute (fan-out)

Loop behavior:
- loop-local limits may be omitted and then use workflow-level global default

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
- `design-docs/qa.md`

## Development Environment

- Runtime: Bun
- Language: TypeScript (strict mode)
- Environment: Nix flakes + direnv
