# Editor Field Update Helpers Refactoring

This document records the next safe extraction boundary in the Svelte workflow editor.

## Overview

After the shared UI contract, workflow typing, visualization derivation, API client, workflow operations, support helpers, state helpers, mutation helpers, and data loaders were extracted, `ui/src/App.svelte` still retains a concentrated block of bundle and node-property update logic.

The current product architecture still matches the intended purpose:

- local Bun HTTP server remains the system boundary
- the browser editor remains a replaceable frontend
- mutable editor state remains frontend-owned

The mismatch is internal maintainability. `App.svelte` still mixes presentation and orchestration with a set of pure or mostly-pure editor field update rules.

## Problem

The component still owns several workflow-editing rules that are not Svelte-specific:

- workflow description and manager-node updates
- node kind and completion updates
- edge field updates
- default-number updates
- node payload string and timeout updates
- variable JSON parsing and synchronization into node payloads

Keeping those rules inline creates three concrete problems:

1. Responsibility concentration
- `App.svelte` remains the canonical home for editor property mutation rules even after structural mutation helpers were extracted

2. Invariant drift
- positive-only fields such as workflow defaults and node timeouts are still normalized ad hoc in the component

3. Testability gap
- property-editing behavior is harder to verify independently than the already-extracted workflow/state/data helper modules

## Decision

Introduce a frontend-owned helper module under `ui/src/lib/` that becomes the canonical location for editor field/property updates against nullable editable state.

This helper owns:

- workflow description and manager-node updates
- node kind and completion updates with explicit reserved-kind rejection
- edge field updates including optional numeric handling
- workflow default and node-timeout numeric updates with positive-integer invariants
- node payload string updates
- node variable JSON synchronization into payloads

`App.svelte` remains responsible for:

- read-only gating
- calling `markWorkflowEdited(...)`
- surfacing returned error messages
- binding DOM events to helper calls

## Intended Outcome

After this refactor:

- `App.svelte` keeps orchestration but no longer owns the canonical field-update logic
- editor property invariants are centralized in one testable helper
- invalid zero-or-negative numeric edits are rejected consistently instead of being normalized differently across handlers

## References

- `design-docs/specs/architecture.md`
- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-editor-mutation-helpers.md`
- `design-docs/specs/design-refactoring-editor-state-helpers.md`
