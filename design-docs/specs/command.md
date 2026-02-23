# Command Design

This document defines CLI interfaces for workflow and session management.

## Overview

Commands are designed around JSON workflow lifecycle operations and writing session execution.

## Sections

### Subcommands

- `workflow create <name>`
  - Create `<workflow-root>/<name>/` with `workflow.json`, `workflow-vis.json`, and template `node-{id}.json`.
- `workflow validate <name>`
  - Validate `<workflow-root>/<name>/` structure and semantic constraints.
- `workflow run <name>`
  - Execute `<workflow-root>/<name>/workflow.json` and referenced `node-{id}.json` files.
- `workflow inspect <name>`
  - Print normalized node graph, fan-out branch rules, loop defaults, timeout defaults, and node file references.
- `session status <session-id>`
  - Show current node, branch state, and loop counters.
- `session resume <session-id>`
  - Continue an interrupted session from persisted state.
- `serve [workflow-name]`
  - Start local HTTP server for browser-based workflow editing and execution.
  - If `workflow-name` is omitted, server starts in workflow selection mode.
  - Serves Svelte application and exposes local API for workflow CRUD/validation/run operations.
- `tui`
  - Start interactive terminal UI for workflow selection and execution.
  - Supports selecting a workflow from `<workflow-root>`.
  - Supports runtime user input for human-input nodes during execution.

### Flags and Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--variables` | string (path) | none | JSON file supplying runtime prompt variables (merged with node variables) |
| `--workflow-root` | string (path) | `./.oyakata` | Root directory containing workflow definitions |
| `--artifact-root` | string (path) | `./.oyakata/workflow` | Root directory for execution artifacts |
| `--workflow` | string | none | Workflow name for direct TUI launch (skip workflow chooser) |
| `--resume-session` | string | none | Session id to resume in TUI |
| `--tui-log-level` | string | `info` | Log verbosity in TUI panel (`error`, `warn`, `info`, `debug`) |
| `--max-steps` | number | none | Hard cap on node executions per run |
| `--max-loop-iterations` | number | `3` | Override loop budget for safety |
| `--default-timeout-ms` | number | `120000` | Override default node timeout for this run |
| `--output` | string | `text` | Output format (`text` or `json`) |
| `--dry-run` | boolean | `false` | Validate and simulate transitions without agent execution |
| `--host` | string | `127.0.0.1` | Bind address for `serve` |
| `--port` | number | `5173` | Listen port for `serve` |
| `--open` | boolean | `false` | Open browser automatically after `serve` starts |
| `--read-only` | boolean | `false` | Disable write/update operations in `serve` mode |
| `--no-exec` | boolean | `false` | Disable workflow execution endpoints in `serve` mode |

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OYAKATA_DEFAULT_MODEL` | No | none | Default model used only by create/template flows; runtime still requires explicit node `model` |
| `OYAKATA_ARTIFACT_ROOT` | No | `./.oyakata/workflow` | Default root directory for execution artifacts |
| `OYAKATA_WORKFLOW_ROOT` | No | `./.oyakata` | Default workflow definition root directory |
| `OYAKATA_TUI_LOG_LEVEL` | No | `info` | Default TUI log panel verbosity |
| `OYAKATA_SESSION_STORE` | No | local file store | Session state backend selector |
| `OYAKATA_LOG_LEVEL` | No | `info` | Runtime logging level |
| `OYAKATA_SERVE_HOST` | No | `127.0.0.1` | Default bind address for `serve` |
| `OYAKATA_SERVE_PORT` | No | `5173` | Default listen port for `serve` |

Workflow root resolution order:
1. `--workflow-root`
2. `OYAKATA_WORKFLOW_ROOT`
3. `./.oyakata`

Artifact root resolution order:
1. `--artifact-root`
2. `OYAKATA_ARTIFACT_ROOT`
3. `./.oyakata/workflow`

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid workflow directory or JSON |
| 3 | Completion condition not met and no fallback path |
| 4 | Loop limit exceeded |
| 5 | Agent backend invocation error |
| 6 | Node execution timeout |
| 7 | HTTP server startup failure (port bind, config, or static asset error) |
