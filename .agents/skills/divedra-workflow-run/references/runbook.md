# Divedra Workflow Runbook

This runbook is for users operating existing divedra workflow bundles.

## Workflow Discovery

List workflows from a direct root:

```bash
divedra workflow list --workflow-root ./examples
```

List from scoped lookup:

```bash
divedra workflow list
```

Useful filters:

```bash
divedra workflow list --status running --limit 10 --output json
```

Show one workflow overview:

```bash
divedra workflow status <workflow-name> --workflow-root <root>
```

## Validate And Inspect

Validate structure and semantic constraints:

```bash
divedra workflow validate <workflow-name> --workflow-root <root>
```

Inspect normalized structure:

```bash
divedra workflow inspect <workflow-name> --workflow-root <root> --output json
```

`workflow inspect` shows step and node-registry identity fields and derived cross-workflow dispatch metadata from `steps[].transitions`.

## Run

Basic local run:

```bash
divedra workflow run <workflow-name> --workflow-root <root> --output json
```

Recommended supervised run:

```bash
divedra workflow run <workflow-name> \
  --workflow-root <root> \
  --auto-improve \
  --nested-supervisor \
  --max-supervised-attempts 3 \
  --workflow-mutation-mode execution-copy \
  --output json
```

Use supervised execution as the default recommendation for real work. It keeps the target session under an audit-visible supervision policy, detects terminal failures and stalls, can retry or rerun from targeted steps, and can run a paired supervisor workflow when `--nested-supervisor` is enabled.

Run with a deterministic mock scenario:

```bash
divedra workflow run <workflow-name> \
  --workflow-root <root> \
  --mock-scenario <root>/<workflow-name>/mock-scenario.json \
  --output json
```

Run with hard caps:

```bash
divedra workflow run <workflow-name> \
  --workflow-root <root> \
  --max-steps 20 \
  --default-timeout-ms 120000 \
  --output json
```

Dry run:

```bash
divedra workflow run <workflow-name> \
  --workflow-root <root> \
  --dry-run \
  --output json
```

Use `--working-dir <path>` when node execution should occur relative to a specific project directory.

## Sessions

Use the `sessionId` returned by `workflow run`.

Progress:

```bash
divedra session progress <session-id>
```

Full status:

```bash
divedra session status <session-id> --output json
```

Logs:

```bash
divedra session logs <session-id> --format text
divedra session logs <session-id> --format jsonl
```

Export:

```bash
divedra session export <session-id> --file session-export.json
```

Resume:

```bash
divedra session resume <session-id>
```

Rerun from a step:

```bash
divedra session rerun <session-id> <step-id>
```

List merged step-run history:

```bash
divedra session step-runs <session-id>
divedra session step-runs <session-id> --step <step-id>
```

Continue from an imported-history boundary:

```bash
divedra session continue <session-id> \
  --start-step <step-id> \
  --after-step-run <step-run-id>
```

Use `session rerun` when restarting from a step with variables only. Use
`session continue` only when the new execution should import prior history up
to a concrete step-run boundary.

## Local Server And GraphQL

Start server:

```bash
divedra serve --workflow-root <root>
```

Default endpoint:

```text
http://127.0.0.1:43173/graphql
```

Health check:

```bash
curl http://127.0.0.1:43173/healthz
```

GraphQL query:

```bash
divedra gql 'query { workflows(input: {}) }'
```

Endpoint-backed execution:

```bash
divedra workflow run <workflow-name> \
  --workflow-root <root> \
  --endpoint http://127.0.0.1:43173/graphql \
  --output json
```

Remote-capable commands:

- `workflow run`
- `session resume`
- `session rerun`

Local-only commands:

- `call-step`
- `session continue`
- `session step-runs`
- `session export`
- `session logs`

## Direct Step Calls

Use for local debugging of one step in a run context:

```bash
divedra call-step <workflow-id> <workflow-run-id> <step-id> \
  --message-file message.json \
  --output json
```

Useful options:

- `--prompt-variant <name>`
- `--continue-session`
- `--timeout-ms <ms>`
- `--resume-step-exec <execution-record-id>`; this is the same value as `nodeExecId` in session state

Step ids are the supported target. Do not use node-id aliases.

## Auto-Improve

Run with engine-owned supervision:

```bash
divedra workflow run <workflow-name> \
  --workflow-root <root> \
  --auto-improve \
  --max-supervised-attempts 3 \
  --output json
```

Optional nested supervisor:

```bash
divedra workflow run <workflow-name> \
  --workflow-root <root> \
  --auto-improve \
  --nested-supervisor \
  --output json
```

Useful supervision options:

- `--monitor-interval-ms <ms>`
- `--stall-timeout-ms <ms>`
- `--max-supervised-attempts <n>`
- `--max-workflow-patches <n>`
- `--workflow-mutation-mode execution-copy|in-place`
- `--supervisor-workflow <workflow-id>` (`--superviser-workflow` is a legacy alias)

Recommended defaults:

- Use `--auto-improve --nested-supervisor` for production-like or expensive work.
- Use `--workflow-mutation-mode execution-copy` unless the user explicitly asks to patch the canonical workflow bundle in place.
- Set `--max-supervised-attempts` to a small finite number, commonly `3`, to avoid unbounded remediation.
- Use `session status` or `session export` after the run to inspect supervision state.

## Events

Validate event config:

```bash
divedra events validate --workflow-root <root> --event-root <event-root>
```

Emit a fixture event:

```bash
divedra events emit <source-id> \
  --workflow-root <root> \
  --event-root <event-root> \
  --event-file payload.json \
  --mock-scenario <root>/<workflow-name>/mock-scenario.json
```

Start event listeners:

```bash
divedra events serve --workflow-root <root> --event-root <event-root>
```

Inspect receipts:

```bash
divedra events list --source <source-id> --limit 20
```

Replay:

```bash
divedra events replay <receipt-id> --reason "operator retry"
```

## Runtime State

Important options:

- `--workflow-root`: direct workflow definition root.
- `--scope project|user`: scoped lookup selector when no direct root is supplied.
- `--artifact-root`: workflow execution artifact tree.
- `--session-store`: persisted session state root.
- `--log-root`: operator-facing logs.
- `--addon-root`: local add-on root.

Important environment variables:

- `DIVEDRA_WORKFLOW_ROOT`
- `DIVEDRA_WORKFLOW_SCOPE`
- `DIVEDRA_ARTIFACT_ROOT`
- `DIVEDRA_SESSION_STORE`
- `DIVEDRA_ARTIFACT_DIR`
- `DIVEDRA_GRAPHQL_ENDPOINT`
- `DIVEDRA_MANAGER_AUTH_TOKEN`
- `DIVEDRA_MANAGER_SESSION_ID`

Resolution priority for workflow definitions:

1. `--workflow-root`
2. `DIVEDRA_WORKFLOW_ROOT`
3. `--scope` or `DIVEDRA_WORKFLOW_SCOPE`
4. scoped project/user catalog lookup

## Failure Triage

Workflow not found:

- Confirm the workflow directory is `<workflow-root>/<workflow-name>/workflow.json`.
- Pass `--workflow-root` explicitly.
- Check project/user scope shadowing with `workflow list`.

Validation fails:

- Run `workflow inspect` only after validation passes.
- Fix authored schema errors; current divedra rejects legacy top-level workflow routing fields.

Run failed:

- Check `session status <session-id> --output json`.
- Check `session progress <session-id>`.
- Check `session logs <session-id> --format text`.
- Reproduce with `--mock-scenario` if the failure is backend-dependent.

Remote execution fails:

- Check `serve` is running.
- Check `/healthz`.
- Pass `--endpoint` explicitly or set `DIVEDRA_GRAPHQL_ENDPOINT`.
- Do not use `--mock-scenario` with `--endpoint`.
