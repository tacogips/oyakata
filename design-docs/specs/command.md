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
- `gql <graphql-document>`
  - Execute a GraphQL query or mutation against the canonical control-plane endpoint.
  - Manager-node LLM/tool use should call GraphQL mutations such as `sendManagerMessage` through this command rather than dedicated domain subcommands.
  - When `OYAKATA_MANAGER_SESSION_ID` is present, the CLI forwards it to `/graphql` with `X-Oyakata-Manager-Session-Id` so manager-scoped mutations do not need to repeat it in GraphQL variables.
- `serve [workflow-name]`
  - Start local HTTP server for browser-based workflow editing and execution.
  - If `workflow-name` is omitted, server starts in workflow selection mode.
  - Serves the built browser frontend from `ui/dist/`, keeps the current local editor REST API during migration, and adds the GraphQL control plane.
  - Exposes the canonical GraphQL control-plane endpoint at `/graphql` for execution, communication, and manager-control operations.
  - Returns an explicit UI-unavailable response when the built frontend bundle is missing.
- `tui`
  - Start interactive terminal UI for workflow selection and execution.
  - Supports selecting a workflow from `<workflow-root>`.
  - Supports runtime user input for human-input nodes during execution.

### Flags and Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--variables` | string | none | For legacy execution commands: JSON file supplying runtime prompt variables. For `oyakata gql`: inline GraphQL variables JSON or `@path/to/variables.json` |
| `--workflow-root` | string (path) | `./.oyakata` | Root directory containing workflow definitions |
| `--artifact-root` | string (path) | derived from `OYAKATA_ROOT_DATA_DIR` or `./.oyakata-datas/workflow` | Root directory for execution artifacts |
| `--workflow` | string | none | Workflow name for direct TUI launch (skip workflow chooser) |
| `--resume-session` | string | none | Session id to resume in TUI |
| `--tui-log-level` | string | `info` | Log verbosity in TUI panel (`error`, `warn`, `info`, `debug`) |
| `--max-steps` | number | none | Hard cap on node executions per run |
| `--max-loop-iterations` | number | `3` | Override loop budget for safety |
| `--default-timeout-ms` | number | `120000` | Override default node timeout for this run |
| `--output` | string | `text` | Output format (`text` or `json`) for CLI-rendered GraphQL results |
| `--dry-run` | boolean | `false` | Validate and simulate transitions without agent execution |
| `--endpoint` | string | local serve endpoint | GraphQL endpoint used by CLI commands |
| `--auth-token` | string | none | Explicit auth token for GraphQL manager/control-plane requests |
| `--auth-token-env` | string | `OYAKATA_MANAGER_AUTH_TOKEN` | Environment variable used to resolve GraphQL auth token |
| `--host` | string | `127.0.0.1` | Bind address for `serve` |
| `--port` | number | `43173` | Listen port for `serve` |
| `--open` | boolean | `false` | Open browser automatically after `serve` starts |
| `--read-only` | boolean | `false` | Disable write/update operations in `serve` mode |
| `--no-exec` | boolean | `false` | Disable workflow execution endpoints in `serve` mode |

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OYAKATA_DEFAULT_MODEL` | No | none | Default model used only by create/template flows; runtime still requires explicit node `model` |
| `OYAKATA_ARTIFACT_ROOT` | No | derived from `OYAKATA_ROOT_DATA_DIR` or `./.oyakata-datas/workflow` | Default root directory for execution artifacts |
| `OYAKATA_WORKFLOW_ROOT` | No | `./.oyakata` | Default workflow definition root directory |
| `OYAKATA_TUI_LOG_LEVEL` | No | `info` | Default TUI log panel verbosity |
| `OYAKATA_SESSION_STORE` | No | local file store | Session state backend selector |
| `OYAKATA_LOG_LEVEL` | No | `info` | Runtime logging level |
| `OYAKATA_SERVE_HOST` | No | `127.0.0.1` | Default bind address for `serve` |
| `OYAKATA_SERVE_PORT` | No | `43173` | Default listen port for `serve` |
| `OYAKATA_ROOT_DATA_DIR` | No | `./.oyakata-datas` | Canonical Oyakata root data directory used to resolve artifact, session, and attachment file references |
| `OYAKATA_RUNTIME_ROOT` | No | compatibility alias | Legacy compatibility alias for `OYAKATA_ROOT_DATA_DIR` during the migration |
| `OYAKATA_GRAPHQL_ENDPOINT` | No | local serve endpoint | Default GraphQL endpoint for CLI manager/control-plane commands |
| `OYAKATA_MANAGER_AUTH_TOKEN` | No | none | Manager-session auth token for `oyakata gql` and GraphQL control-plane mutations |
| `OYAKATA_MANAGER_SESSION_ID` | No | none | Ambient manager session id forwarded by `oyakata gql` to `/graphql` for manager-scoped requests |
| `OYAKATA_WORKFLOW_ID` | No | none | Ambient workflow id for manager tool environments |
| `OYAKATA_WORKFLOW_EXECUTION_ID` | No | none | Ambient workflow execution id for manager tool environments |
| `OYAKATA_MANAGER_NODE_ID` | No | none | Ambient manager node id for manager tool environments |
| `OYAKATA_MANAGER_NODE_EXEC_ID` | No | none | Ambient manager node execution id for manager tool environments |

Workflow root resolution order:
1. `--workflow-root`
2. `OYAKATA_WORKFLOW_ROOT`
3. `./.oyakata`

Artifact root resolution order:
1. `--artifact-root`
2. `OYAKATA_ARTIFACT_ROOT`
3. `OYAKATA_ROOT_DATA_DIR/workflow`
4. `./.oyakata-datas/workflow`

Session store root resolution order:
1. `--session-store`
2. `OYAKATA_SESSION_STORE`
3. `OYAKATA_ROOT_DATA_DIR/sessions`
4. existing runtime default

GraphQL control-plane resolution order:
1. `--endpoint`
2. `OYAKATA_GRAPHQL_ENDPOINT`
3. local `oyakata serve` default (`http://127.0.0.1:43173/graphql`)

Data-root file reference rule:
1. GraphQL file/image parameters use data-root-relative paths, not host absolute paths
2. Those paths are resolved under `OYAKATA_ROOT_DATA_DIR`
3. `sendManagerMessage.attachments` must stay within `files/{workflowId}/{workflowExecutionId}/...`
4. Attachment files must already exist before the GraphQL request; first-iteration design does not add an upload mutation

## GraphQL Canonicalization

GraphQL is the canonical domain-parameter transport during migration for:

- workflow execution requests,
- communication inspection,
- communication replay/retry,
- manager send/control-plane requests.

Compatibility rule:

- domain parameters should be modeled in GraphQL inputs,
- `oyakata gql` is the thin generic GraphQL client now, and legacy execution commands may opt into GraphQL transport with `--endpoint` while the rest of the CLI migrates incrementally,
- local-only debug flags such as `--mock-scenario` are not forwarded when a legacy command is executed remotely through GraphQL,
- existing REST endpoints remain supported until the browser/editor surfaces migrate.

Supporting design: `design-docs/specs/design-graphql-manager-control-plane.md`.

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
