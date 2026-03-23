# TUI Workflow Browser and JSON Input Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-tui.md#main-layout, design-docs/specs/design-tui.md#data-and-artifact-integration
**Created**: 2026-03-23
**Last Updated**: 2026-03-23

## Related Plans

- **Previous**: `impl-plans/completed/workflow-tui-mvp.md`
- **Previous**: `impl-plans/completed/workflow-tui-cli-parity.md`
- **Previous**: `impl-plans/tui-resume-runtime-variable-merge.md`
- **Depends On**: `impl-plans/node-execution-inbox-contract.md`

## Design Document Reference

**Source**:

- `design-docs/specs/design-tui.md`

### Summary

Expand `divedra tui` from a workflow selector into a stateful workflow browser that can:

- browse workflows and historical workflow executions,
- inspect node-level inbox/outbox and execution logs,
- run and rerun workflows directly from the TUI,
- prefill rerun input from historical runtime state,
- switch input editing between text and JSON based on workflow-definition hints, with JSON formatting support.

### Scope

**Included**:

- `neo-blessed` runtime dependency declaration
- richer interactive TUI state in `src/tui/neo-blessed-screen.ts`
- local CLI integration for run/rerun/resume callbacks in `src/cli.ts`
- targeted regression coverage for input-mode detection and runtime-variable construction

**Excluded**:

- web UI changes
- GraphQL/browser TUI parity
- live streaming execution progress inside the TUI event loop

## Modules

### 1. Interactive TUI Application

#### `src/tui/neo-blessed-screen.ts`

**Status**: COMPLETED

```typescript
type TuiWorkflowInputMode = "json" | "text";

interface NeoBlessedWorkflowAppOptions {
  readonly workflowNames: readonly string[];
  readonly loadWorkflowDefinition: (
    workflowName: string,
  ) => Promise<LoadedWorkflow>;
  readonly listWorkflowSessions: (
    workflowName: string,
  ) => Promise<readonly RuntimeSessionSummary[]>;
  readonly loadRuntimeSessionView: (
    sessionId: string,
  ) => Promise<RuntimeSessionView>;
  readonly loadManagerSessionMessages: (
    managerSessionId: string,
  ) => Promise<readonly ManagerMessageRecord[]>;
  readonly executeWorkflow: (input: {
    readonly workflowName: string;
    readonly runtimeVariables: Readonly<Record<string, unknown>>;
  }) => Promise<NeoBlessedWorkflowActionResult>;
  readonly rerunWorkflow: (input: {
    readonly sourceSessionId: string;
    readonly fromNodeId: string;
    readonly runtimeVariables: Readonly<Record<string, unknown>>;
  }) => Promise<NeoBlessedWorkflowActionResult>;
  readonly resumeWorkflow: (
    sessionId: string,
  ) => Promise<NeoBlessedWorkflowActionResult>;
}
```

**Checklist**:

- [x] Workflow list and historical session list render in one TUI flow
- [x] Node executions can be inspected per session
- [x] Inbox/outbox/log/manager-session details are visible from the details pane
- [x] Input editor supports text mode and JSON mode with JSON formatting
- [x] New run, rerun, and resume actions execute from the TUI

### 2. CLI Integration

#### `src/cli.ts`

**Status**: COMPLETED

```typescript
interface TuiRuntimeSessionView {
  readonly session: WorkflowSessionState;
  readonly nodeExecutions: readonly RuntimeNodeExecutionSummary[];
  readonly nodeLogs: readonly RuntimeNodeLogEntry[];
}
```

**Checklist**:

- [x] Interactive `tui` path invokes the richer `neo-blessed` app first
- [x] TUI run/rerun callbacks merge `--variables` overrides correctly
- [x] TUI input now always maps plain text into `runtimeVariables.humanInput`
- [x] Interactive `--resume-session` opens the workflow browser on the target session when the workflow bundle is available
- [x] Readline fallback remains available when `neo-blessed` cannot start

### 3. Targeted Regression Coverage

#### `src/tui/neo-blessed-screen.test.ts`

**Status**: COMPLETED

```typescript
interface TuiWorkflowInputDetection {
  readonly mode: TuiWorkflowInputMode;
  readonly reason: string;
}
```

**Checklist**:

- [x] Text vs JSON input-mode detection is covered
- [x] TUI runtime-variable construction is covered
- [x] JSON formatting helper is covered

## Module Status

| Module              | File Path                       | Status    | Tests                                |
| ------------------- | ------------------------------- | --------- | ------------------------------------ |
| Interactive TUI app | `src/tui/neo-blessed-screen.ts` | COMPLETED | `src/tui/neo-blessed-screen.test.ts` |
| CLI integration     | `src/cli.ts`                    | COMPLETED | `src/cli.test.ts`                    |
| Runtime dependency  | `package.json`, `bun.lock`      | COMPLETED | Install verified                     |

## Dependencies

| Feature                       | Depends On                                        | Status |
| ----------------------------- | ------------------------------------------------- | ------ |
| Session/node inspection       | Existing session persistence + runtime DB helpers | READY  |
| Inbox/outbox detail rendering | Node mailbox artifact contract                    | READY  |
| JSON editor switching         | Workflow definition loading                       | READY  |

## Tasks

### TASK-001: Replace the selector-only TUI with a stateful workflow browser

**Status**: Completed
**Parallelizable**: No

**Deliverables**:

- `src/tui/neo-blessed-screen.ts`
- `src/tui/neo-blessed-screen.test.ts`

**Completion Criteria**:

- [x] TUI shows workflow/session/node panes and a details pane
- [x] TUI can inspect inbox/outbox and workflow execution logs
- [x] TUI detects text vs JSON input mode and formats JSON

### TASK-002: Wire run/rerun/resume callbacks through `src/cli.ts`

**Status**: Completed
**Parallelizable**: No
**Dependencies**: TASK-001

**Deliverables**:

- `src/cli.ts`

**Completion Criteria**:

- [x] Interactive TUI path uses local workflow/session/runtime callbacks
- [x] TUI run/rerun actions merge runtime variables correctly
- [x] Plain-text TUI input also populates `humanInput`

### TASK-003: Declare the TUI runtime dependency

**Status**: Completed
**Parallelizable**: Yes

**Deliverables**:

- `package.json`
- `bun.lock`

**Completion Criteria**:

- [x] `neo-blessed` is declared explicitly
- [x] Bun install leaves no untrusted dependency scripts

## Completion Criteria

- [x] Interactive TUI supports workflow browsing, historical session inspection, and rerun actions
- [x] JSON-capable workflow input editing is supported with formatting
- [x] `bun run typecheck:server` passes
- [x] `bun test src/tui/neo-blessed-screen.test.ts src/cli.test.ts` passes

## Progress Log

### Session: 2026-03-23 17:24 JST

**Tasks Completed**: TASK-001, TASK-002, TASK-003
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Replaced the selector-only interactive TUI with a richer `neo-blessed` workflow browser that can inspect workflow history, node inbox/outbox, and manager-session messages while launching new runs, reruns, and resumes from within the screen. Added TUI-side text/JSON input-mode detection plus JSON formatting, fixed interactive TUI runtime-variable construction so text input also flows through `humanInput`, declared `neo-blessed` in Bun dependencies, and verified the slice with server typecheck plus targeted CLI/TUI tests.

### Session: 2026-03-23 18:05 JST

**Tasks Completed**: Post-diff review follow-up
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Reviewed the pending diff as a continuation of the TUI browser work and found two concrete gaps. First, `design-docs/specs/design-tui.md` still described the older three-pane selector/timeline layout, so the design doc was updated to match the shipped four-pane workflow browser, JSON/text editor behavior, and actual keybindings. Second, the CLI wrapped the full-screen TUI in an over-broad fallback path that could hide real application errors as readline fallback; this was tightened so only `neo-blessed` availability failures degrade to readline while normal TUI bugs now surface. Also fixed the new session-store default-root test so it ignores the repo dev-shell `DIVEDRA_ARTIFACT_DIR` override when asserting the computed default path.

### Session: 2026-03-23 18:30 JST

**Tasks Completed**: Post-diff review hardening
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Continued the diff review and fixed two more quality issues. The computed default artifact-root path encoding now normalizes path-hostile characters so Windows-style drive letters and similar inputs do not produce invalid directory names under `~/.divedra/project/...`. The neo-blessed fallback classifier was also narrowed again so only concrete module/widget availability failures fall back to readline. Finally, the implementation-tracking state was synchronized by marking phase 71 as completed in `impl-plans/PROGRESS.json`.

### Session: 2026-03-23 19:05 JST

**Tasks Completed**: Interactive resume-session TUI alignment
**Tasks In Progress**: None
**Blockers**: None
**Notes**: The post-diff review found that `divedra tui --resume-session <id>` still forced the legacy fallback path even on interactive terminals, which contradicted the workflow-browser design. The CLI/runtime-mode flow now enters the full-screen TUI with the requested session preselected when the workflow definition is still available, while non-interactive or workflow-missing cases keep the direct resume fallback. Also tightened the TUI editor prefill logic so JSON-oriented historical sessions reopen from `promptJson`/`userPromptJson` rather than collapsing to text-oriented defaults.

### Session: 2026-03-23 19:25 JST

**Tasks Completed**: Neo-blessed resume fallback hardening
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Continued the same TUI/browser plan with one more post-diff correction. When the interactive workflow browser cannot start because `neo-blessed` is unavailable, `divedra tui --resume-session <id>` now preserves direct-resume behavior instead of dropping into the generic readline workflow prompt, which could not preserve the selected historical session. The CLI gained small TUI entrypoint dependency hooks so this fallback contract can be regression-tested directly.

### Session: 2026-03-23 19:50 JST

**Tasks Completed**: Mock-scenario fallback parity cleanup
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Reviewed the same TUI/browser diff for one more continuation bug and a maintainability issue. The full-screen `neo-blessed` flow already auto-discovered workflow-local `mock-scenario.json`, but the direct fallback/resume branches did not, so identical `divedra tui` commands could behave differently depending on whether `neo-blessed` loaded. The CLI now routes interactive execution, rerun, resume, and fallback flows through shared local run-option assembly and shared mock-scenario resolution, and regression coverage now proves that `--resume-session` fallback still succeeds with only the workflow-local mock scenario present.
