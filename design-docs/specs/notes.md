# Design Notes

This document captures additional design notes for cooperative multi-agent orchestration.

## Overview

The project uses workflow-driven coordination where agent behavior is explicit and auditable.

## Notable Decisions

### Primary Agent Providers

Initial design scope includes exactly two tacogips execution backends:
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
- `node-{id}.json`: runtime payload (`executionBackend`, `model`, `promptTemplate`, `variables`)
- `workflow-vis.json`: browser visualization state (`order`, etc.; `indent`/`color` are derived)

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
- Conversation handoff: `oyakata` routes by explicit `OutputRef` (`workflowExecutionId`, `outputNodeId`, `nodeExecId`, and optional `subWorkflowId` for sub-workflow outputs) instead of implicit latest-output inference.
- Node mailbox transport: messages are persisted as hierarchical manager-routed file mailboxes with per-workflow-execution `communicationId` allocation owned by the root workflow manager. The parent workflow manager writes only to the recipient sub-workflow manager inbox, and the recipient sub-workflow manager writes only to nodes inside that sub-workflow (validated via `subWorkflows[].nodeIds`). A re-executed/resubmitted send always allocates a new `communicationId`; delivery retries for an already-created send keep the same `communicationId` and advance `deliveryAttemptId` (and optional `agentSessionId`). See `design-docs/specs/design-node-mailbox.md`.

### Completion-First Progression

A node should not transition until completion criteria are evaluated.
This supports quality gates in collaborative writing workflows.

### Open Items

- See `design-docs/qa.md` for current decision status and any remaining confirmation items.

### Migration Rule

- Existing workflow-run `sessionId` in runtime/session-store code is the old name for `workflowExecutionId`.
- New design docs must use `workflowExecutionId` for workflow-run scope and `agentSessionId` for worker retry scope.
- Bare `sessionId` is allowed only as a temporary compatibility alias in existing APIs and persisted workflow-run state.
- Compatibility window is fixed: keep `sessionId` alias support through `2026-09-30`, then remove it in the first subsequent minor release.

### Refactoring Investigation Plan

- Repository-wide refactoring investigation is tracked in `design-docs/specs/design-refactoring-investigation-plan.md`.
- The investigation is intentionally split into multiple passes so architectural, type-safety, DRY, hardcoding, and test-safety concerns can be analyzed separately before implementation planning.
- Shared browser/server transport typing is tracked in `design-docs/specs/design-refactoring-shared-ui-contract.md`.
- Shared derived visualization reuse is tracked in `design-docs/specs/design-refactoring-shared-visualization-derivation.md`.
- Shared editable workflow typing is tracked in `design-docs/specs/design-refactoring-shared-editable-workflow-types.md`.
- Frontend browser/API client extraction is tracked in `design-docs/specs/design-refactoring-editor-api-client.md`.
- Frontend workflow-structure operations extraction is tracked in `design-docs/specs/design-refactoring-editor-workflow-operations.md`.
- Frontend support-helper extraction is tracked in `design-docs/specs/design-refactoring-editor-support-helpers.md`.
- Frontend state-helper extraction is tracked in `design-docs/specs/design-refactoring-editor-state-helpers.md`.
- Frontend mutation-helper extraction is tracked in `design-docs/specs/design-refactoring-editor-mutation-helpers.md`.
- Frontend workflow/session data-loader extraction is tracked in `design-docs/specs/design-refactoring-editor-data-loaders.md`.
- Frontend async action-helper extraction is tracked in `design-docs/specs/design-refactoring-editor-action-helpers.md`.
- Frontend field/property update helper extraction is tracked in `design-docs/specs/design-refactoring-editor-field-updates.md`.
- Frontend execution-form request helper extraction is tracked in `design-docs/specs/design-refactoring-editor-execution-helpers.md`.
- Frontend center-panel component extraction is tracked in `design-docs/specs/design-refactoring-editor-main-panel-component.md`.
- Server API request-parsing helper extraction is tracked in `design-docs/specs/design-refactoring-server-api-request-parsing.md`.
- Server UI asset-serving helper extraction is tracked in `design-docs/specs/design-refactoring-server-ui-asset-serving.md`.
- SolidJS migration-preparation also requires framework-aware UI tooling to validate dependency availability explicitly before build/typecheck execution, because the repository can temporarily keep a checked-in Svelte entrypoint while SolidJS remains the active architectural target.
