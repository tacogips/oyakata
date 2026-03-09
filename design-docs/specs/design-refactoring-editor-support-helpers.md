# Editor Support Helpers Refactoring

This document defines the next refactoring slice for the browser workflow editor after shared contracts, shared workflow types, visualization derivation, API client extraction, and workflow-structure operations extraction.

## Overview

The current architecture still matches the intended purpose: a replaceable browser editor over the local JSON API with shared workflow domain models. The remaining maintainability mismatch is still inside the frontend implementation boundary.

`ui/src/App.svelte` still mixes:

- Svelte lifecycle and view orchestration
- user-facing message handling
- JSON form parsing and positive-integer parsing
- validation-issue merging and deduplication
- workflow dirty-state comparison
- session presentation helpers

Those helpers are frontend-owned, but they are not component-template concerns. Keeping them inside the Svelte component makes later state/store extraction harder and leaves repeated error/parsing logic harder to test in isolation.

## Decision

Extract the remaining pure editor support helpers from `ui/src/App.svelte` into a frontend-owned module under `ui/src/lib/`.

The extracted module will own:

- JSON parsing and positive-integer parsing helpers for editor forms
- validation issue merge/deduplication helpers
- workflow dirty-state comparison helpers
- session status presentation helpers
- consistent unknown-error to message conversion

## Design Rules

1. The extracted module remains frontend infrastructure.
It may depend on shared UI contracts and shared workflow types, but it must stay under `ui/src/lib/` because it models browser-editor support behavior, not reusable backend domain logic.

2. `App.svelte` remains the orchestration layer.
The component still decides when to call helpers, update Svelte state, and surface user-facing messages. The helper module only provides pure support functions.

3. Shared contracts stay canonical.
Validation and session helpers must reuse `src/shared/ui-contract.ts` and `src/workflow/types.ts` instead of redeclaring local response or issue shapes.

4. Scope stays incremental.
This slice does not introduce Svelte stores, split the template into components, or redesign workflow/session behavior.

## Intended Impact

- reduce responsibility concentration in `ui/src/App.svelte`
- centralize repeated parsing and error-to-message logic
- improve naming consistency for frontend support helpers
- make later extraction of editor stores or session services safer

## Out of Scope

- server API changes
- component decomposition
- workflow schema changes
- browser behavior changes

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-editor-api-client.md`
- `design-docs/specs/design-refactoring-editor-workflow-operations.md`
- `ui/src/App.svelte`
