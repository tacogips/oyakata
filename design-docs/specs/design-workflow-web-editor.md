# Workflow Web Editor and Serve Mode Design

This document defines the browser editing and execution design for `oyakata`.

## Overview

Add a local web interface so users can:
- Edit workflow structure and node payloads with Svelte UI
- Start local HTTP server via `oyakata serve`
- Execute workflows from the UI and monitor session progress

The server and UI are local-first and operate on the existing `.oyakata/<workflow-name>/` directory contract.

Current-state note:
- The documented target is Svelte, but the current implementation still ships a large inline HTML/JavaScript editor from the Bun server.
- This is an implementation mismatch, not a design mismatch.
- Migration must therefore preserve behavior while replacing the inline editor with a built Svelte frontend over multiple iterations.

## Goals

1. Provide visual workflow editing without changing canonical file split.
2. Reuse existing execution engine behavior from CLI run path.
3. Keep file format deterministic and compatible with non-UI workflows.
4. Support safe local concurrent editing and reliable saves.

## Non-Goals

- Remote multi-user collaboration
- Cloud-hosted workflow execution service
- Real-time push transport (WebSocket) in first iteration

## User Flows

### Workflow Editing

1. User starts server with `oyakata serve`.
2. User chooses workflow from list or creates one from template.
3. User edits:
- Graph nodes/edges and conditions
- Node payload (`executionBackend`, `model`, `promptTemplate`, `variables`, optional `timeoutMs`)
- Vertical sequence metadata (`order`)
- Structural sub-workflow metadata (`subWorkflows[].block.type`, and `block.loopId` for loop bodies)
4. User saves; server writes:
- `workflow.json`
- `workflow-vis.json`
- `node-{id}.json` files

### Workflow Execution

1. User clicks Run in browser.
2. UI calls execute endpoint with optional runtime variable overrides.
3. Server creates session and starts engine.
4. UI polls session API for node progress and terminal status.
5. User can cancel run from UI.

## Server Architecture

Single-process local runtime:
- Static asset serving for Svelte app from `ui/dist/`
- JSON API for workflow and session operations
- Shared workflow validation and execution services used by CLI commands
- UI bootstrap/config endpoint (`GET /api/ui-config`) for fixed-workflow, read-only, and no-exec mode flags
- Compatibility fallback to the legacy inline editor while `ui/dist/` is absent

Data safety:
- Atomic writes (`*.tmp` then rename)
- Revision check on update (`revision` or equivalent hash/version)
- Validation before save commit

## API Contract (v1)

### Workflow APIs

- `GET /api/workflows`
  - Returns names and basic metadata.
- `GET /api/workflows/:name`
  - Returns normalized workflow data and current revision.
- `PUT /api/workflows/:name`
  - Request: full normalized workflow payload + expected revision.
  - Response: success + new revision; conflict if stale.
- `POST /api/workflows/:name/validate`
  - Response: structured validation errors/warnings.

### Execution APIs

- `POST /api/workflows/:name/execute`
  - Request: optional runtime variable overrides and limits.
  - Response: `workflowExecutionId` (canonical) and `sessionId` (compatibility alias through `2026-09-30`).
- `GET /api/workflow-executions/:workflowExecutionId`
  - Response: status, active node, completed nodes, branch/loop counters, failures.
- `POST /api/workflow-executions/:workflowExecutionId/cancel`
  - Response: cancellation accepted/ignored (already terminal).
- Legacy compatibility through `2026-09-30`:
  - `GET /api/sessions/:sessionId` (alias to `GET /api/workflow-executions/:workflowExecutionId`)
  - `POST /api/sessions/:sessionId/cancel` (alias to `POST /api/workflow-executions/:workflowExecutionId/cancel`)

## Svelte UI Design

### Migration Strategy

1. Introduce a frontend asset boundary in `oyakata serve`.
2. Add a standalone Svelte app under `ui/` that consumes the existing JSON API.
3. Port browser editor capabilities in slices:
- bootstrap/config + workflow list/loading
- create/save/validate
- structure and node payload editing
- execution/session inspection
4. Cut over the default `/` route to the built Svelte bundle once feature parity is acceptable.
5. Remove the legacy inline editor after parity and browser verification are complete.

### Frontend Build Contract

- Svelte source lives under `ui/src/`.
- The Vite project root is `ui/`, even when build commands are run from the repository root.
- Production assets are emitted to `ui/dist/`.
- The server serves `index.html` for `/` and `/ui` and serves any existing built file under `ui/dist/` by exact path for non-API requests.
- The frontend must not require server mode flags at build time; it must fetch `/api/ui-config` on startup.
- Repository-level verification must explicitly run Svelte-aware frontend checks in addition to the Bun server tests because the root TypeScript config does not include `ui/`, and plain `tsc` is not sufficient to validate `.svelte` components.
- Repository automation therefore exposes distinct server and UI verification commands, and the UI path uses `svelte-check` plus a production bundle build so Svelte verification is not accidentally skipped during migration.

### Editor Surface

- Vertical workflow list (top-to-bottom) with card-based node rendering
- Property panel for selected node/edge/sequence row
- Workflow defaults panel
- Save/validate controls

### Vertical Interaction Model

- Nodes remain cards, rendered in strict vertical order from `workflow-vis.json.nodes[].order`.
- Reordering uses row drag-handle and/or move-up/move-down controls.
- Nesting for loop/group semantics uses derived `indent` level from graph structure.
- Loop/group visual distinction uses derived semantic `color` tokens from scope metadata.
- Sub-workflow authoring includes explicit block typing:
  - `plain` for ordinary grouped sub-workflows
  - `branch-block` for branch bodies
  - `loop-body` for loop bodies, with a selectable `loops[].id`
- Local editor visualization must match backend derivation rules:
  - `branch-block` colors as a branch scope
  - `loop-body` sub-workflows take precedence over inferred loop intervals
  - typed structural scopes (`loop-body`, then `branch-block`) keep their color precedence even when they contain nested plain groups
- Reserved structure roles (`root-manager`, `sub-manager`, `input`, `output`) are derived from workflow manager and sub-workflow boundary configuration, not assigned manually through generic node-kind editing.
- Edge creation/editing is form-driven (source/target/when), not canvas drawing.
- Validation blocks invalid links (self-loop rules, missing node, duplicate edge policy).

### Execution Surface

- Run configuration dialog
- Session timeline with current node highlight
- Structured logs/events panel
- Cancel button and terminal summary

### Validation UX

- Field-level validation (fast local checks)
- Server validation (authoritative)
- Error list links back to relevant node row/form control

## Security and Operational Constraints

- Bind default server to `127.0.0.1`.
- Optional read-only mode for review usage.
- Optional no-exec mode for editing-only usage.
- Reject path traversal in workflow-name routing.
- Input payload size limits for API endpoints.

## Compatibility and Migration

- Existing workflows remain valid.
- Legacy `workflow-vis.json` coordinate fields (`x`,`y`,`width`,`height`,`viewport`) are normalized into sequential vertical order on save.
- Missing `workflow-vis.json` is auto-generated on first save.
- Existing CLI `workflow run` and `workflow validate` remain functional.

## Open Decisions

1. Poll interval default and maximum for session status API.
2. Whether to include incremental save endpoints or only full-document save.
3. Whether to add import/export UX in first release or defer.
4. Standard palette and indentation guide width for loop/group visual clarity.
