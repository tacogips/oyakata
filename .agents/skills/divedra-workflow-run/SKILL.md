---
name: divedra-workflow-run
description: Use when helping an end user run, inspect, monitor, resume, continue, rerun, export, or troubleshoot existing divedra workflows. Applies to workflow list/status/validate/inspect/run, session progress/status/logs/export/resume/continue/rerun/step-runs, mock scenarios, workflow roots, runtime artifacts, local serve, GraphQL endpoint execution, and event-triggered workflow usage.
metadata:
  short-description: Run divedra workflows
---

# Divedra Workflow Run

Use this skill for operating existing divedra workflows. For creating or editing workflow bundles, use `divedra-workflow` instead.

## First Decision

Identify what the user wants:

- Find workflows: use `workflow list` or `workflow status`.
- Check a workflow before running: use `workflow validate` and optionally `workflow inspect`.
- Run locally: use `workflow run`; for important or long-running work, prefer supervised execution with `--auto-improve`.
- Run deterministically without real agents: add `--mock-scenario`.
- Monitor an existing run: use `session progress`, `session status`, or `session logs`.
- Continue a run: use `session resume`.
- Start from a specific step in an existing session: use `session rerun <session-id> <step-id>`.
- Continue from a concrete prior step-run artifact boundary: use `session continue <session-id> --start-step <step-id> --after-step-run <step-run-id>`.
- Inspect merged execution history by step: use `session step-runs <session-id>`.
- Use a remote control plane: start or target `serve` and pass `--endpoint`.
- Debug one step locally: use `call-step`.

Read `references/runbook.md` when the task involves sessions, remote endpoints, mock scenarios, event dispatch, auto-improve, or troubleshooting.

## Command Forms

Inside the divedra source repo, prefer:

```bash
bun run src/main.ts <command>
```

When divedra is installed, prefer:

```bash
divedra <command>
```

Use `--workflow-root <path>` when the workflow directory is not coming from scoped project/user lookup. In this repository, examples use `--workflow-root ./examples`.

## Standard Run Sequence

```bash
bun run src/main.ts workflow list --workflow-root ./examples
```

```bash
bun run src/main.ts workflow validate <workflow-name> --workflow-root ./examples
```

```bash
bun run src/main.ts workflow inspect <workflow-name> \
  --workflow-root ./examples \
  --output json
```

```bash
bun run src/main.ts workflow run <workflow-name> \
  --workflow-root ./examples \
  --output json
```

Recommended supervised execution:

```bash
bun run src/main.ts workflow run <workflow-name> \
  --workflow-root ./examples \
  --auto-improve \
  --nested-supervisor \
  --max-supervised-attempts 3 \
  --workflow-mutation-mode execution-copy \
  --output json
```

Use this recommended path when the workflow may need retries, stall detection, remediation, or a supervisor workflow to drive recovery. Use plain `workflow run` for quick local checks, deterministic mock runs, or cases where supervision is intentionally disabled.

For deterministic local testing:

```bash
bun run src/main.ts workflow run <workflow-name> \
  --workflow-root ./examples \
  --mock-scenario ./examples/<workflow-name>/mock-scenario.json \
  --output json
```

## Session Operations

After `workflow run`, capture the returned `sessionId`.

```bash
bun run src/main.ts session progress <session-id>
```

```bash
bun run src/main.ts session status <session-id> --output json
```

```bash
bun run src/main.ts session logs <session-id> --format text
```

```bash
bun run src/main.ts session export <session-id> --file session-export.json
```

```bash
bun run src/main.ts session resume <session-id>
```

```bash
bun run src/main.ts session rerun <session-id> <step-id>
```

```bash
bun run src/main.ts session step-runs <session-id> --step <step-id>
```

```bash
bun run src/main.ts session continue <session-id> \
  --start-step <step-id> \
  --after-step-run <step-run-id>
```

## User-Safe Defaults

- Validate before running unless the user explicitly asks to skip validation.
- Prefer supervised execution with `--auto-improve --nested-supervisor` for real work where failure recovery matters.
- Prefer `--output json` when the result will be parsed, saved, or compared.
- Prefer `--mock-scenario` for demos, tests, and docs because it avoids real backend calls.
- Do not combine `--mock-scenario` with `--endpoint`; mock scenarios are local-only.
- Use `--working-dir` when workflow execution must happen relative to a specific project directory.
- Use `--artifact-root` and `--session-store` when the user wants isolated runtime state.
- Use `session rerun` when restarting from a step with variables only; use `session continue` only when intentionally importing history up to a concrete prior step-run.

## Remote And Server Use

Start the local control plane:

```bash
bun run src/main.ts serve --workflow-root ./examples
```

Then target it:

```bash
bun run src/main.ts workflow run <workflow-name> \
  --workflow-root ./examples \
  --endpoint http://127.0.0.1:43173/graphql \
  --output json
```

Remote-capable operations include `workflow run`, `session resume`, and `session rerun`. `call-step`, `session continue`, `session step-runs`, `session export`, and `session logs` are local-only.

## Troubleshooting

- If a workflow is not found, check `--workflow-root`, `DIVEDRA_WORKFLOW_ROOT`, and scope lookup.
- If validation fails, fix the workflow bundle before running; do not bypass schema errors for normal usage.
- If a run fails, inspect `session status`, `session progress`, and `session logs`.
- If backend calls should not happen, rerun with `--mock-scenario` or `--dry-run` when appropriate.
- If paths are surprising, check `--working-dir`, `--artifact-root`, `--session-store`, and the command invocation directory.
