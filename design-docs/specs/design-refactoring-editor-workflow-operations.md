# Editor Workflow Operations Refactoring

This document defines the next refactoring slice for the browser workflow editor after shared contracts, shared domain types, shared visualization derivation, and API client extraction.

## Overview

The current architecture still matches the intended purpose: a replaceable browser editor over the local JSON API and shared workflow domain model. The remaining maintainability mismatch is inside the frontend implementation boundary.

`ui/src/App.svelte` still mixes:

- Svelte view state and event handling
- pure workflow-structure mutation rules
- sub-workflow boundary selection rules
- derived editor workflow metadata synchronization

Those workflow editing rules are frontend-owned, but they are not view concerns. Keeping them inside the Svelte component makes the editor harder to read, harder to test, and riskier to refactor.

## Decision

Extract the pure workflow editor operations from `ui/src/App.svelte` into a frontend-owned helper module under `ui/src/lib/`.

The extracted module will own:

- workflow ordering and `workflow-vis` normalization helpers
- generated node/sub-workflow id helpers
- sub-workflow membership and boundary candidate rules
- reserved node-kind synchronization for structure nodes
- derived visualization recomputation from the shared workflow helper

## Design Rules

1. The extracted module is frontend infrastructure, not shared backend domain logic.
It may depend on shared workflow types and visualization helpers, but it remains under `ui/src/lib/` because it models editor mutation behavior and nullable UI state handling.

2. `App.svelte` remains the orchestration layer.
The Svelte component still decides when to mark the workflow dirty, update selected-node state, or surface user-facing errors. The helper module only performs pure or bundle-local structural operations.

3. Shared workflow semantics stay canonical.
The helper module must continue to reuse `src/workflow/types.ts` and `src/workflow/visualization.ts` rather than copying structural rules into new local interfaces or algorithms.

4. Scope remains incremental.
This slice does not decompose the entire editor into stores/components and does not redesign workflow JSON semantics.

## Intended Impact

- reduce responsibility concentration in `ui/src/App.svelte`
- make workflow editing rules easier to read and reason about
- improve naming consistency for frontend-only workflow operations
- make later extraction of stores or focused editor services safer

## Out of Scope

- UI layout/component decomposition
- server API changes
- workflow schema changes

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-shared-editable-workflow-types.md`
- `design-docs/specs/design-refactoring-shared-visualization-derivation.md`
- `ui/src/App.svelte`
