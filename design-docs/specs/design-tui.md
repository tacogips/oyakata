# TUI Design

This document defines terminal UI design for workflow selection and execution in Bun.

## Overview

`divedra tui` provides:
- workflow browsing from `<workflow-root>`
- historical session and node-execution inspection
- interactive workflow run, rerun, and resume flows
- text or JSON runtime input editing based on workflow-definition hints
- artifact-oriented execution trace visibility aligned with runtime outputs

The TUI uses the same workflow loader and execution engine as CLI and serve mode.

## Framework Selection

Selected framework: `neo-blessed` (Bun runtime, TypeScript integration).

Why:
- Full-screen TUI primitives (list/log/input/detail panes) needed for workflow browser + execution console.
- Mature event model for keyboard-driven UX.
- Works as a Node-style terminal library that Bun can run in practice via compatibility layer.

Not selected now:
- `Ink`: strong React model, but current Bun input compatibility concerns exist in open issue tracking.
- prompt-only libraries: insufficient for multi-pane live execution/trace experience.

Selection policy:
- Keep TUI framework swappable behind a thin UI adapter.
- Re-evaluate `Ink` after Bun compatibility issue closure.

## Interaction Model

### Startup

Command:
- `divedra tui`
- `divedra tui --workflow <name>` (skip selector)
- `divedra tui --resume-session <id>` (open the TUI focused on that historical session when interactive; direct-resume fallback when non-interactive, when the workflow bundle is unavailable, or when `neo-blessed` itself is unavailable)

Workflow root resolution:
1. `--workflow-root`
2. `DIVEDRA_WORKFLOW_ROOT`
3. `./.divedra`

### Main Layout

Four-pane default layout:
- Left: workflow list
- Mid-left: historical session list for the selected workflow
- Mid-right: node-execution list for the selected session
- Right: detail pane for summary, inbox, outbox, manager-session, or session-log views

Bottom panels:
- input editor for new runs and reruns
- status and key-hint panel

### Human Input Handling

The current TUI does not wait for a runtime pause before collecting input. Instead:
1. loading a workflow inspects input-node payloads and bindings
2. the editor defaults to `text` or `json` mode based on structured `human-input` hints
3. the operator can edit the input buffer at any time
4. `n` starts a new run with editor-derived runtime variables
5. `r` reruns from the selected node execution
6. `u` resumes the selected workflow session
7. interactive `--resume-session <id>` preselects the target session instead of bypassing the browser; non-interactive and `neo-blessed`-unavailable fallback paths still resume immediately rather than degrading to a generic workflow prompt

Runtime-variable mapping:
- text mode writes string values to `humanInput`, `prompt`, and `userPrompt`
- json mode writes structured values to `humanInput`, `promptJson`, and `userPromptJson`
- rerun actions also write `rerunPrompt`, plus `rerunManagerSessionId` when the selected node is a manager node

## Data and Artifact Integration

Per-node execution output location:
- `{DIVEDRA_ARTIFACT_DIR}/workflow/{workflow_id}/executions/{workflowExecutionId}/nodes/{nodeId}/{nodeExecId}/` (default root under `~/.divedra/project/<cwd-encoded>/divedra-artifact/`)

TUI behavior:
- displays active artifact directory for the selected node execution
- summarizes `input.json`, `output.json`, `meta.json`, mailbox `inbox/input.json`, and mailbox `meta.json`
- loads manager-session records from the manager-session store for manager nodes
- loads node execution and session log summaries from the runtime DB
- never mutates historical `output.json`; only appends new runs
- uses a readline fallback only when `neo-blessed` is unavailable, except that `--resume-session` preserves direct-resume semantics because readline mode cannot represent a preselected historical session; ordinary TUI logic errors must surface as failures instead of being silently downgraded

## Keybindings (Initial)

- `j` / `k`: move selection
- `tab` / `shift-tab`: cycle focus across workflows, sessions, nodes, and input
- `enter`: load the focused workflow/session/node or start editing input
- `n`: run workflow with current editor content
- `r`: rerun from the selected node execution
- `u`: resume the selected workflow session
- `m`: toggle input mode between text and JSON
- `f`: format JSON input when JSON mode is active
- `i` / `o` / `g` / `a` / `s`: show inbox, outbox, session logs, manager messages, or summary
- `R`: refresh workflow/session/runtime state
- `q`: quit

## Failure and Recovery

- On terminal resize: relayout without dropping execution state.
- On non-interactive terminal: fallback to plain prompt mode with same engine.
- On TUI crash: session remains recoverable through `session resume` or `divedra tui --resume-session`.

## Implementation Notes

- Runtime: Bun
- Language: TypeScript strict mode
- UI adapter boundary: isolate direct `neo-blessed` usage in one module so replacement cost is low.
- Do not duplicate workflow logic in UI; UI consumes workflow definitions, session snapshots, runtime DB summaries, and mailbox artifacts exposed by existing runtime modules.

## References

- Bun runtime docs: https://bun.sh/docs
- neo-blessed package: https://www.npmjs.com/package/neo-blessed
- Ink package: https://www.npmjs.com/package/ink
- Bun + Ink compatibility issue: https://github.com/oven-sh/bun/issues/6862
