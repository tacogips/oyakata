# Editor Data Loaders Refactoring

This document defines the next refactoring slice for the Svelte workflow editor's data-loading paths.

## Overview

The current product architecture still matches the intended local-server plus replaceable-frontend design, but `ui/src/App.svelte` still concentrates multi-request workflow/session loading paths:

- workflow list loading and selected-workflow reconciliation
- workflow fetch plus editable-state adaptation
- session list loading and selected-session reconciliation
- workflow create bootstrap flow

Those flows are now one of the main remaining maintainability hotspots because they mix transport calls with repeated selection-reset rules and workflow/session state adaptation.

## Intended Boundary

Introduce a frontend-owned data-loader module under `ui/src/lib/` that centralizes async workflow/session hydration for the browser editor.

Responsibilities of the loader module:

- call the existing frontend API client helpers
- normalize selected workflow name resolution
- compose workflow response data into `WorkflowEditorState`
- compose session list data into `SessionPanelState`
- keep selected execution reconciliation consistent across refresh/load/create flows
- parallelize independent workflow and session fetches where the selected-state logic does not require sequential ordering
- avoid redundant API reads for deterministic empty session state, such as immediately after creating a brand-new workflow
- treat stale selected executions as a recoverable reconciliation case when the session summary and detail reads disagree temporarily
- treat lagging session-summary reads as a recoverable reconciliation case when selected execution detail is newer than `/api/sessions`, so the selected card and selected detail stay internally consistent

Responsibilities that remain in `App.svelte`:

- busy/loading flags
- timer ownership for polling
- user-facing success/error messages
- direct DOM event handlers and Svelte-local mutations

## Why This Boundary

This boundary keeps `App.svelte` as the orchestration layer for the UI while removing repeated async data-loading rules that do not need to live in the component itself.

It also reduces the risk of drift between:

- initial page refresh
- workflow switching
- workflow creation
- session refresh after execution activity

This boundary should also own stale-session reconciliation. If a selected execution disappears between the session summary read and the detail fetch, the loader should clear the selection and return a consistent session panel state instead of failing the whole workflow load.

This boundary should also own selected-session summary normalization. If the selected execution detail is available but `/api/sessions` has not yet included that execution or has an older status snapshot, the loader should synthesize or refresh the selected summary entry so the session list and session detail panel do not diverge.

Within this boundary, transport efficiency is part of maintainability: request fan-out and selected-state reconciliation should live together so later behavior changes do not reintroduce duplicated sequential fetch flows in the component.

## Expected Module Shape

Target module:

- `ui/src/lib/editor-data.ts`

Expected capabilities:

- load workflow picker state
- load workflow editor state plus reconciled session panel state
- load workflow-scoped session panel state
- create workflow and return ready-to-apply editor/session state

## Non-Goals

- changing server routes
- changing browser-visible behavior
- replacing `App.svelte` with Svelte stores/components
- moving polling timers out of the component
