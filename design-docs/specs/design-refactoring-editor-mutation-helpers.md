# Editor Mutation Helpers Refactoring

This document defines the next refactoring slice for the browser workflow editor after shared contracts, shared workflow types, visualization derivation, API client extraction, workflow-structure operations extraction, support helpers, and state helpers.

## Overview

The current architecture still matches the intended purpose: a replaceable browser editor over the local JSON API with shared workflow domain models. The remaining maintainability mismatch is still inside the frontend implementation boundary.

`ui/src/App.svelte` still mixes:

- Svelte lifecycle and view orchestration
- user-facing message handling
- bundle-level workflow mutation commands for nodes, edges, loops, and sub-workflows
- cleanup rules for derived references when structure changes

Those mutation rules are frontend-owned, but they are not component-template concerns. Keeping them inline makes `App.svelte` harder to review, and it increases the risk that one edit path updates references or payload cleanup differently from another.

## Decision

Extract the remaining bundle-mutation helpers from `ui/src/App.svelte` into a frontend-owned module under `ui/src/lib/`.

The extracted module will own:

- node add/remove helpers
- edge and loop add/remove helpers
- sub-workflow add/remove/update helpers
- input-source mutation helpers
- bundle-local cleanup such as stale node payload removal and reference rewrites
- fail-fast identifier invariants for editor-owned rename flows such as loop ids and sub-workflow ids

## Design Rules

1. The extracted module remains frontend infrastructure.
It may depend on shared workflow types and existing editor helper modules, but it stays under `ui/src/lib/` because it models browser-editor mutation behavior against nullable editable state.

2. `App.svelte` remains the orchestration layer.
The component still decides when to block edits for read-only mode, when to mark the workflow dirty, and when to show user-facing messages. The helper module only performs bundle-local mutations and returns explicit success/error results when needed.

3. Shared workflow semantics stay canonical.
Mutation helpers must continue to reuse `src/workflow/types.ts` and the existing extracted editor helper modules instead of re-declaring workflow structures or duplicating cleanup rules.

4. Scope stays incremental.
This slice does not introduce Svelte stores, split the template into components, or redesign workflow/session behavior.

## Intended Impact

- reduce responsibility concentration in `ui/src/App.svelte`
- centralize bundle mutation rules and cleanup behavior
- centralize editor-side rename invariants so obviously invalid duplicate or empty identifiers do not survive until later validation
- make structure-changing edits easier to test and reason about
- close stale reference or payload cleanup gaps found during continuation review

## Out of Scope

- server API changes
- component decomposition
- workflow schema changes
- browser behavior changes

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-editor-workflow-operations.md`
- `design-docs/specs/design-refactoring-editor-support-helpers.md`
- `design-docs/specs/design-refactoring-editor-state-helpers.md`
- `ui/src/App.svelte`
