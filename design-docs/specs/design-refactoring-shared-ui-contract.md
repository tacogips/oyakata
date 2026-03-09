# Shared UI/API Contract Refactoring

This document defines the first implementation-oriented refactoring slice from the repository-wide refactoring investigation.

## Overview

The current architecture intends the browser workflow editor to be a replaceable frontend over the local JSON API. In practice, that boundary is duplicated:

- `src/server/api.ts` defines the runtime response shapes implicitly in route handlers
- `ui/src/App.svelte` redefines matching transport types locally

This duplication weakens type safety and makes naming drift around `workflowExecutionId` and legacy `sessionId` aliasing more likely. The same drift now exists on the request side as well: browser execution request shapes are split between frontend and server helper modules instead of flowing through one shared contract.

## Observed Mismatch

Facts from the current codebase:

- `src/server/api.ts` and `ui/src/App.svelte` both relied on locally-assumed frontend mode values
- the Svelte app duplicates response contracts such as `UiConfig`, `WorkflowResponse`, `SessionSummary`, `ValidationResponse`, `ExecuteWorkflowResponse`, and `CancelSessionResponse`
- the Svelte app still carries fallback logic like `workflowExecutionId || sessionId`, even though the canonical execution endpoints already return both fields
- some server routes still returned ad hoc JSON objects without being checked against the shared contract, including workflow list/save responses and rerun payload naming
- the architecture document describes the frontend as consuming the existing local API, but it does not currently require a shared source of truth for that API contract

## Decision

Introduce a canonical shared TypeScript contract module for the browser/API boundary.

The module will:

- live under `src/shared/` so it is frontend-safe and not coupled to Node-only server code
- export the JSON transport request and response types used by both `src/server/api.ts` and `ui/src/App.svelte`
- make `workflowExecutionId` a required field for canonical execution-oriented responses while preserving `sessionId` as an explicit compatibility alias
- keep the bootstrap contract aligned with the server's single supported browser surface instead of preserving stale fallback-mode unions after the inline UI is removed

## Design Rules

1. Transport contracts are distinct from editable UI state.
The shared module should define API request/response payload types, not mutable editor-local models.

2. Canonical execution naming is `workflowExecutionId`.
Compatibility aliases may remain in responses, but the frontend should treat `workflowExecutionId` as authoritative when present by contract.
This includes rerun responses: they should expose canonical `workflowExecutionId` fields for both source and new executions while preserving the legacy `sessionId` aliases during the compatibility window.

3. Shared contracts must avoid Node runtime dependencies.
The module may import TypeScript types from workflow/session modules, but it must not depend on server-only runtime helpers.

4. Shared request bodies must not be duplicated across frontend and server helpers.
When the browser and server both know the shape of a JSON request body, the type belongs in `src/shared/ui-contract.ts`.

5. Refactoring scope stays incremental.
This iteration only consolidates the transport boundary and small naming helpers. It does not attempt to decompose `src/server/api.ts` or `ui/src/App.svelte` wholesale.

## Intended Impact

- reduce duplicated transport type definitions
- reduce duplicated request payload definitions
- tighten naming consistency between server and browser code
- make later decomposition of `api.ts` and `App.svelte` safer
- keep compatibility behavior explicit instead of ad hoc

## Out of Scope

- redesigning API routes
- replacing mutable UI-local workflow editing types with shared readonly domain models
- removing legacy inline UI as part of this specific contract-refactoring slice itself; only the shared bootstrap contract should stay aligned when that migration completes elsewhere

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/architecture.md`
