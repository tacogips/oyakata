# Editor Component Boundary Refactoring

Historical note: this document describes the Svelte component-boundary extraction completed before the SolidJS migration became the active frontend target. It remains useful as migration context, but it is no longer the target-state frontend design.

This document defines the next refactoring slice for the Svelte workflow editor after the helper-module extractions.

## Overview

The current product architecture still matches the intended local-server plus replaceable-frontend design, but `ui/src/App.svelte` remains the dominant maintainability hotspot.

The prior refactoring slices extracted:

- shared browser/server contracts
- editor workflow/state/support helpers
- API client, data loaders, action helpers, and execution helpers

Even after those changes, `App.svelte` still owns three large concerns at once:

- top-level page orchestration and lifecycle
- sidebar and execution/session panel markup
- the shared presentation styling those panels rely on

That concentration keeps the file large, makes UI-specific changes harder to review, and leaves no stable component boundary for later editor-panel decomposition.

## Decision

Introduce explicit Svelte component boundaries for the workflow sidebar and the execution/session sidebar, plus a shared frontend-owned stylesheet for the editor shell.

Target modules:

- `ui/src/lib/components/WorkflowSidebar.svelte`
- `ui/src/lib/components/ExecutionPanel.svelte`
- `ui/src/lib/editor-ui.css`

## Intended Boundary

The extracted components own:

- panel-local markup
- panel-local input bindings
- panel-local button wiring through typed callback props
- session/status presentation reuse through existing frontend helpers

The shared stylesheet owns:

- page/panel/layout styling shared across `App.svelte` and the extracted side panels
- shared utility class definitions already used by the editor shell

`App.svelte` remains responsible for:

- lifecycle hooks
- async orchestration and polling timer ownership
- editable workflow state ownership
- center-column editor markup and mutation handlers
- top-level message and mode rendering

## Why This Boundary

This is the next safe step after helper extraction:

- it reduces component size without redesigning runtime behavior
- it keeps state ownership centralized while separating view structure
- it creates stable component seams for later extraction of the center editor surface
- it removes CSS duplication pressure by making shared presentation rules explicit

## Non-Goals

- introducing Svelte stores
- redesigning the workflow/session API
- decomposing the full center editor surface in this slice
- changing browser-visible behavior

## References

- `design-docs/specs/design-workflow-web-editor.md`
- `design-docs/specs/design-refactoring-investigation-plan.md`
- `impl-plans/refactoring-frontend-solidjs-migration.md`
- `ui/src/App.svelte`
