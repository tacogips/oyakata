# Editor Main Panel Component Refactoring

Historical note: this document describes the Svelte main-panel extraction completed before the SolidJS migration became the active frontend target. It remains useful as migration context, but it is no longer the target-state frontend design.

This document defines the next safe UI refactoring slice after the side-panel component extraction.

## Overview

The current product architecture still matches the intended local-server plus replaceable-frontend design. The remaining mismatch is internal maintainability: `ui/src/App.svelte` still owns almost the entire center workflow-editor surface even after helper extraction and side-panel decomposition.

That remaining concentration keeps one file responsible for:

- top-level page orchestration and lifecycle
- workflow editor center-panel markup
- structure-editing form wiring
- node inspector form wiring
- validation result rendering

Those are all UI concerns, but they are not all `App.svelte` concerns.

## Decision

Introduce an explicit center-panel component boundary for the workflow editor surface.

Target module:

- `ui/src/lib/components/WorkflowEditorPanel.svelte`

`App.svelte` remains responsible for:

- lifecycle hooks
- async orchestration and polling ownership
- mutable editor/session state ownership
- applying returned state into Svelte locals
- user-facing page-level messages

`WorkflowEditorPanel.svelte` owns:

- workflow editor center-column markup
- node list rendering
- node inspector rendering
- structure/loop/sub-workflow form rendering
- callback wiring from DOM events into typed component props

## Why This Boundary

This is the next safe extraction after the existing helper and side-panel refactors:

- it reduces the size and cognitive load of `App.svelte`
- it keeps state ownership centralized while moving view-heavy markup into a dedicated component
- it removes a large amount of DOM-event parsing from `App.svelte`
- it creates a stable seam for future decomposition of node inspector and structure sections

## Design Rules

1. `App.svelte` remains the state owner.
The extracted component receives current editor state plus typed callback props. It must not become a hidden store or secondary source of truth.

2. DOM-event parsing belongs with rendered controls.
Where possible, the component should translate DOM events into typed callback values so `App.svelte` does not keep low-level element-casting noise.

3. Shared workflow/editor types remain canonical.
The component must continue to consume `src/shared/` contracts and `ui/src/lib/` editor helper types instead of redefining local copies.

4. Scope stays incremental.
This slice does not introduce Svelte stores, redesign the editor UX, or change server/API behavior.

## Intended Impact

- reduce responsibility concentration in `ui/src/App.svelte`
- improve readability of both orchestration code and editor markup
- make future center-panel subcomponent extraction safer
- keep naming and event-to-state boundaries more consistent

## Non-Goals

- changing workflow editing behavior
- moving state out of `App.svelte`
- redesigning the API or server routes
- decomposing the center panel into multiple nested components in this same slice

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-editor-component-boundaries.md`
- `design-docs/specs/design-workflow-web-editor.md`
- `ui/src/App.svelte`
