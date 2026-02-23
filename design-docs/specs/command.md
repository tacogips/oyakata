# Command Design

This document defines CLI interfaces for workflow and session management.

## Overview

Commands are designed around JSON workflow lifecycle operations and writing session execution.

## Sections

### Subcommands

- `workflow create <name>`
  - Create `.oyakata/<name>/` with `workflow.json`, `workflow-vis.json`, and template `node-{id}.json`.
- `workflow validate <name>`
  - Validate `.oyakata/<name>/` structure and semantic constraints.
- `workflow run <name>`
  - Execute `.oyakata/<name>/workflow.json` and referenced `node-{id}.json` files.
- `workflow inspect <name>`
  - Print normalized node graph, fan-out branch rules, loop defaults, timeout defaults, and node file references.
- `session status <session-id>`
  - Show current node, branch state, and loop counters.
- `session resume <session-id>`
  - Continue an interrupted session from persisted state.

### Flags and Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--variables` | string (path) | none | JSON file supplying runtime prompt variables (merged with node variables) |
| `--max-steps` | number | none | Hard cap on node executions per run |
| `--max-loop-iterations` | number | `3` | Override loop budget for safety |
| `--default-timeout-ms` | number | `120000` | Override default node timeout for this run |
| `--output` | string | `text` | Output format (`text` or `json`) |
| `--dry-run` | boolean | `false` | Validate and simulate transitions without agent execution |

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OYAKATA_DEFAULT_MODEL` | No | none | Fallback model when node model is omitted |
| `OYAKATA_SESSION_STORE` | No | local file store | Session state backend selector |
| `OYAKATA_LOG_LEVEL` | No | `info` | Runtime logging level |

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
