# TUI Design

This document defines terminal UI design for workflow selection and execution in Bun.

## Overview

`divedra tui` provides:
- workflow browsing from `<workflow-root>` with a dedicated workspace screen
- historical session and node-execution inspection
- interactive workflow run, rerun, and resume flows with a dedicated new-run screen
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
- `divedra tui --workflow <name>` (skip the workspace screen and open the workflow-history screen)
- `divedra tui --resume-session <id>` (open the workflow-history screen focused on that historical session when interactive; direct-resume fallback when non-interactive, when the workflow bundle is unavailable, or when `neo-blessed` itself is unavailable)

Workflow root resolution:
1. `--workflow-root`
2. `DIVEDRA_WORKFLOW_ROOT`
3. `./.divedra`

### Screen Model

The TUI uses three primary screens instead of a single always-expanded multi-pane layout.

#### Workspace Screen

Default screen when `divedra tui` starts without `--workflow` or `--resume-session`.

Layout:
- Left pane: workflow list
- Right pane: workflow preview showing workflow description plus a visual node summary

Behavior:
1. the selector screen is dedicated to choosing a workflow, not browsing sessions and nodes yet
2. pressing `/` opens a popup filter input
3. the popup accepts a workflow-name substring filter and immediately narrows the workflow list
4. `enter` or `l` opens the highlighted workflow in the workflow-history screen
5. `ctrl-m` opens the new-run screen for the highlighted workflow
6. pressing `?` opens a help popup, and `q` closes that popup

Workflow preview content:
- workflow description
- workflow id and high-level counts
- visually ordered node structure derived from `workflow-vis.json`
- per-node metadata such as workflow node kind, node type, backend/model when present, and concise node help text derived first from node-level `description`, then from output descriptions or prompt summaries
- the preview pane should not duplicate keybinding hints; shortcuts live in the help popup only

Filtering rules:
- filtering is local to the currently loaded workflow name list
- filter matching is case-insensitive substring matching
- clearing the popup input restores the full workflow list
- cancelling the popup keeps the previously visible filtered result unchanged

#### Workflow History Screen

Shown after a workflow is selected, or immediately when `--workflow` or interactive `--resume-session` is used.

Layout:
- Left pane: historical workflow-session list for the selected workflow
- Right pane: node-execution list for the selected session
- Bottom large pane: details view for summary, inbox, outbox, manager-session messages, or session logs
- Bottom input area: run/rerun input editor

Design intent:
- keep the workflow selector mentally separate from workflow execution history
- reduce first-screen noise by not showing sessions and nodes before a workflow is chosen
- reserve the larger lower area for details because inbox/outbox and logs are multi-line artifacts
- avoid a permanently visible status/help bar; transient guidance lives in a popup opened with `?`

#### New Workflow Run Screen

Shown from the workspace screen via `ctrl-m`, or from the workflow-history screen via `n`.

Layout:
- Left pane: workflow detail preview using the same workflow-structure rendering style as the workspace preview
- Right pane: realtime execution status for the newly launched workflow session
- Bottom input area: workflow input editor

Behavior:
1. when the screen opens, the input editor is focused immediately
2. the operator types plain text or JSON depending on detected workflow input mode
3. `enter` or `ctrl-m` from this screen opens a confirmation popup instead of dispatching immediately
4. confirming the popup starts the workflow and returns the new `sessionId` immediately to the TUI
5. the right pane polls runtime session state and log summaries while the workflow is running
6. the right pane must show both intermediate progress and final result data when available
7. `l` jumps from the new-run screen into the workflow-history screen for the same workflow
8. `h` returns to the workspace screen

### Human Input Handling

The current TUI does not wait for a runtime pause before collecting input. Instead:
1. entering the workflow-history or new-run screen inspects input-node payloads and bindings
2. the editor defaults to `text` or `json` mode based on structured `human-input` hints
3. the operator can edit the input buffer at any time
4. the workflow-history screen can open the new-run screen with `n`
5. the new-run screen launches a new run only after explicit confirmation
6. `r` reruns from the selected node execution
7. `u` resumes the selected workflow session
8. interactive `--resume-session <id>` preselects the target session instead of bypassing the browser; non-interactive and `neo-blessed`-unavailable fallback paths still resume immediately rather than degrading to a generic workflow prompt

Runtime-variable mapping:
- text mode writes string values to `humanInput`, `prompt`, and `userPrompt`
- json mode writes structured values to `humanInput`, `promptJson`, and `userPromptJson`
- rerun actions also write `rerunPrompt`, plus `rerunManagerSessionId` when the selected node is a manager node

JSON-editor expectations:
- when a workflow definition implies structured human input, the editor starts in `json` mode
- the input area must accept raw JSON objects, not only plain text
- JSON mode must expose syntax validity in the status area
- JSON mode must support formatting the current buffer
- run and rerun actions must reject invalid JSON before dispatch
- when reopening a historical JSON-oriented session, the editor should prefer structured runtime values such as `promptJson` or `userPromptJson`

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

### Workspace Screen

- `j` / `k`: move selection
- `/`: open workflow filter popup
- `?`: open help popup
- `enter` / `l`: open the highlighted workflow in the workflow-history screen
- `ctrl-m`: open the highlighted workflow in the new-run screen
- `R`: refresh workflow list
- `q`: quit

### Workflow History Screen

- `j` / `k`: move selection within the focused pane
- `tab` / `shift-tab`: cycle focus across sessions, nodes, and input
- `enter` / `ctrl-m`: load the focused session or node, or begin input editing
- `n`: open the new-run screen for the current workflow
- `r`: rerun from the selected node execution
- `u`: resume the selected workflow session
- `m`: toggle input mode between text and JSON
- `f`: format JSON input when JSON mode is active
- `i` / `o` / `g` / `a` / `s`: show inbox, outbox, session logs, manager messages, or summary
- `?`: open help popup
- `h`: return to the workspace screen
- `R`: refresh workflow/session/runtime state
- `q`: quit

### New Workflow Run Screen

- input focus is active on entry
- `enter` / `ctrl-m`: open the confirmation popup for launch
- `m`: toggle input mode between text and JSON
- `f`: format JSON input when JSON mode is active
- `l`: open the workflow-history screen for the same workflow
- `h`: return to the workspace screen
- `R`: refresh workflow preview and current run-status pane
- `?`: open help popup
- `q`: quit

### Popups

- workflow filter popup: opened by `/`, applied by `enter` or `ctrl-m`, cancelled by `esc`
- help popup: opened by `?`, closed by `q`
- run confirmation popup: opened by `enter` or `ctrl-m` on the new-run screen, confirmed by `enter` or `ctrl-m`, cancelled by `esc`

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
