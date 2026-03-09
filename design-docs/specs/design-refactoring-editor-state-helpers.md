# Editor State Helpers Refactoring

This document records the next safe extraction boundary in the Svelte workflow editor.

## Overview

After the shared UI contract, workflow typing, visualization derivation, API client, workflow operations, and support helpers were extracted, `ui/src/App.svelte` still retains concentrated responsibility for workflow/session state transitions.

The current architecture still matches the intended product design:

- local Bun HTTP server remains the system boundary
- the browser editor remains a replaceable frontend
- mutable editor state remains frontend-owned

The mismatch is internal maintainability, not top-level architecture. `App.svelte` still mixes presentation with repeated state-reset and selection-reconciliation rules.

## Problem

The component still owns multiple pure or mostly-pure transitions:

- resetting workflow editor state when no workflow is selected
- cloning and applying a loaded workflow bundle into editable state
- reconciling selected node state after workflow edits
- filtering session lists to the selected workflow
- clearing invalid session selection when the current execution disappears

Keeping those transitions inline creates three concrete problems:

1. Repetition
- workflow/session reset paths are duplicated across `refresh`, `selectWorkflow`, `loadWorkflow`, and `createWorkflow`

2. Bug surface
- when a new workflow is loaded or created, stale validation or selection state can survive unless each reset path is updated consistently

3. Responsibility concentration
- `App.svelte` remains both the orchestration layer and the canonical home for editor state-transition rules

## Decision

Introduce a frontend-owned helper module under `ui/src/lib/` that becomes the canonical location for pure editor state helpers.

This helper owns:

- empty workflow editor state factories
- empty session-panel state factories
- loaded-workflow to editable-workflow adaptation
- selected-node reconciliation against the editable bundle
- workflow-scoped session filtering and selection reconciliation

`App.svelte` remains responsible for:

- user-triggered async actions
- Svelte lifecycle hooks
- user-facing messages
- binding helper-produced state into the rendered UI

## Intended Outcome

After this refactor:

- `App.svelte` keeps orchestration but no longer owns the canonical workflow/session reset logic
- repeated workflow/session clearing paths become consistent
- future refactors can move from helper extraction toward component/store decomposition without re-solving the same state-transition rules

## References

- `design-docs/specs/architecture.md`
- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-editor-support-helpers.md`
