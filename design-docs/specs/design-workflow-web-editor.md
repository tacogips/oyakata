# Workflow Web Editor and Serve Mode Design

This document defines the browser editing and execution design for `oyakata`.

## Overview

Add a local web interface so users can:
- Edit workflow structure and node payloads with Svelte UI
- Start local HTTP server via `oyakata serve`
- Execute workflows from the UI and monitor session progress

The server and UI are local-first and operate on the existing `.oyakata/<workflow-name>/` directory contract.

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
- Node payload (`model`, `promptTemplate`, `variables`, optional `timeoutMs`)
- Vertical sequence metadata (`order`)
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
- Static asset serving for Svelte app
- JSON API for workflow and session operations
- Shared workflow validation and execution services used by CLI commands

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
  - Response: `sessionId`.
- `GET /api/sessions/:sessionId`
  - Response: status, active node, completed nodes, branch/loop counters, failures.
- `POST /api/sessions/:sessionId/cancel`
  - Response: cancellation accepted/ignored (already terminal).

## Svelte UI Design

### Editor Surface

- Vertical workflow list (top-to-bottom) with card-based node rendering
- Property panel for selected node/edge/sequence row
- Workflow defaults panel
- Save/validate controls

### Vertical Interaction Model

- Nodes remain cards, rendered in strict vertical order from `workflow-vis.json.nodes[].order`.
- Reordering uses row drag-handle and/or move-up/move-down controls.
- Nesting for loop/group semantics uses derived `indent` level from graph structure.
- Loop/group visual distinction uses derived semantic `color` tokens from loop/group scope.
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
