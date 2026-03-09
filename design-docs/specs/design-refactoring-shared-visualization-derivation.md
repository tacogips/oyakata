# Shared Visualization Derivation Refactoring

This document defines the next refactoring slice after the shared UI/API transport contract consolidation.

## Overview

The browser editor and backend already share the persisted workflow model, but the browser still recomputes derived visualization metadata with a second copy of the same algorithm.

That duplication creates a maintenance risk:

- `src/workflow/visualization.ts` is already the canonical derivation logic for indentation and color scope metadata
- `ui/src/App.svelte` carries a parallel implementation with matching interval and color resolution rules
- changes to sub-workflow or loop visualization semantics can drift between server-loaded data and client-side recomputation

## Decision

Promote `src/workflow/visualization.ts` to the single source of truth for derived workflow visualization.

The Svelte editor will import and reuse the shared pure helper instead of maintaining a frontend-local copy.

## Design Rules

1. Shared derivation logic must stay runtime-portable.
`src/workflow/visualization.ts` may depend on workflow model types only. It must remain free of Node-only APIs so both the server and Vite/Svelte runtime can execute it.

2. Derived visualization is not editable source data.
The frontend may keep mutable workflow editing state, but indentation and scope-color derivation should always come from the shared helper rather than handwritten recomputation inside components.

3. UI-local state may narrow the shared result, but not reimplement it.
If the editor only needs a subset of fields from `DerivedVisNode`, it may project them after calling the shared helper.

## Intended Impact

- remove duplicate interval/color derivation code from `ui/src/App.svelte`
- reduce risk of drift between server-side and client-side visualization semantics
- make future visualization rule changes land in one module

## Out of Scope

- redesigning the visualization algorithm itself
- replacing the frontend-local editable workflow bundle with shared readonly domain objects
- broader decomposition of `ui/src/App.svelte`

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-shared-ui-contract.md`
- `src/workflow/visualization.ts`
