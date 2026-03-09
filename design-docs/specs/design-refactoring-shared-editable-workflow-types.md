# Shared Editable Workflow Types Refactoring

This document defines the next refactoring slice after shared transport contracts and shared visualization derivation.

## Overview

The browser editor now shares API transport contracts and visualization derivation with the server/domain layer, but it still duplicates most of the persisted workflow model in `ui/src/App.svelte`.

That duplication is a maintainability mismatch:

- `src/workflow/types.ts` already defines the canonical workflow bundle, node payload, edge, loop, and sub-workflow types
- `ui/src/App.svelte` re-declares matching interfaces for local editing
- type drift already occurred once when the UI-local `WorkflowJson` omitted `branching`

## Decision

Reuse the shared workflow domain types inside the Svelte editor and keep only narrowly scoped UI-local extensions where the editor truly owns extra fields.

For this iteration:

- the canonical workflow bundle shape comes from `src/workflow/types.ts`
- mutable editor state is represented as deep-mutable aliases of those shared readonly domain types
- UI-only additions stay explicit, not hidden behind silent shape drift

## Design Rules

1. Shared domain types remain the source of truth.
The editor must not maintain handwritten copies of persisted workflow structures that already exist in `src/workflow/types.ts`.

2. Mutable editor state is an adaptation layer, not a forked schema.
If the editor needs mutable arrays or assignable properties, it should derive them from the shared readonly types through local utility aliases.

3. UI-only fields must be visibly additive.
If a field exists only for editor presentation and is not part of the persisted model, it must be modeled as an explicit local extension instead of being mixed into a duplicated interface definition.

4. Scope remains incremental.
This slice does not decompose `ui/src/App.svelte` into stores/components, and it does not redesign the workflow schema itself.

## Intended Impact

- remove another large block of duplicated TypeScript interfaces from the Svelte editor
- tighten frontend type safety around workflow bundle editing
- reduce future schema drift between server/domain code and the browser editor

## Out Of Scope

- changing workflow JSON semantics
- moving editor state out of `ui/src/App.svelte`
- replacing all UI-local helper types

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-shared-ui-contract.md`
- `design-docs/specs/design-refactoring-shared-visualization-derivation.md`
- `src/workflow/types.ts`
