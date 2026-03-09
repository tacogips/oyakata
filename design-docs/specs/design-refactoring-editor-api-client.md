# Editor API Client Refactoring

This document defines the next refactoring slice for the browser workflow editor.

## Overview

The current architecture still matches the intended purpose: a replaceable browser editor over the local JSON API. The maintainability mismatch is now inside the frontend implementation boundary.

`ui/src/App.svelte` currently owns all of these responsibilities at once:

- view state and interaction handling
- mutable workflow editing logic
- typed JSON transport calls
- HTTP error translation
- workflow save conflict handling
- execution/session fetch paths

The earlier refactoring slices removed duplicated contracts and duplicated derivation logic, but they did not change this responsibility concentration.

## Decision

Extract a frontend-owned typed API client module under `ui/src/lib/` and make `ui/src/App.svelte` consume that module instead of performing raw fetches directly.

The extracted module will:

- centralize typed fetch and JSON parsing for browser/API calls
- reuse the canonical shared response contracts under `src/shared/`
- keep workflow save conflict handling explicit
- keep route construction and request-body shapes in one place

## Design Rules

1. The API client is frontend infrastructure, not domain state.
It should not own mutable editor state, visualization derivation, or workflow editing rules.

2. `App.svelte` remains the orchestration layer.
The component still decides when to load, save, validate, execute, and poll. The new module only performs transport work and returns typed results.

3. Shared contracts remain canonical.
The client must import transport response types from `src/shared/ui-contract.ts` instead of redefining local request/response interfaces.

4. Scope stays incremental.
This slice does not redesign the API, replace the Svelte component structure, or move editor mutation logic into stores.

## Intended Impact

- reduce mixed responsibilities inside `ui/src/App.svelte`
- remove repeated fetch/error/request boilerplate
- make later extraction of session polling or workflow-editor services safer
- improve naming consistency around workflow execution routes

## Out of Scope

- decomposing the entire Svelte component into subcomponents
- changing API payload semantics
- server-side route decomposition in `src/server/api.ts`

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-shared-ui-contract.md`
- `design-docs/specs/design-refactoring-shared-editable-workflow-types.md`
- `ui/src/App.svelte`
