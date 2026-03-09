# Editor Action Helpers Refactoring

This document defines the next refactoring slice for the browser workflow editor's async command orchestration.

## Overview

The current product architecture still matches the intended local-server plus replaceable-frontend design, but `ui/src/App.svelte` still concentrates most async editor commands:

- initial refresh/bootstrap sequencing
- workflow switching and workflow creation orchestration
- validation and save command orchestration
- execution/session refresh/cancel command orchestration
- user-facing success message selection tied to command outcomes

The previous refactoring slices extracted transport, data loading, field updates, mutation helpers, and execution-request shaping. The remaining hotspot is command orchestration that composes those helpers but still lives inside the Svelte component.

## Intended Boundary

Introduce a frontend-owned action-helper module under `ui/src/lib/` that centralizes async editor command flows.

Responsibilities of the new module:

- compose existing API-client and loader helpers into command-level workflows
- keep workflow/session reload sequencing consistent after save, execute, cancel, and refresh actions
- centralize command result shaping for validation summaries and success messages
- keep request/result typing explicit at the command boundary
- remain testable through dependency injection instead of relying on Svelte component state

Responsibilities that remain in `App.svelte`:

- busy/loading flags
- timer ownership for session polling
- direct DOM event handlers
- applying returned state to Svelte local variables
- read-only and feature-gating guards

## Why This Boundary

This boundary removes orchestration logic that does not need direct access to Svelte internals while preserving the component as the UI state owner.

It also reduces the risk that later feature work reintroduces drift between:

- initial bootstrap and manual refresh
- workflow selection and post-save reload
- execution acceptance and selected-session refresh
- cancellation refresh and selected-session reconciliation

Validation summary/message formatting also belongs here because it is command-result policy, not view rendering.

## Expected Module Shape

Target module:

- `ui/src/lib/editor-actions.ts`

Expected capabilities:

- refresh the editor bootstrap state
- load a selected workflow into ready-to-apply editor/session state
- create a workflow and return ready-to-apply picker/editor state
- validate the current editable bundle and return a normalized summary
- save the current editable bundle and return reloaded editor/session state
- refresh/select/cancel workflow sessions through one command boundary
- execute a workflow and return the newly selected session state plus status message

## Non-Goals

- changing API routes or payload semantics
- moving polling timers out of the component
- decomposing the visual markup in `App.svelte`
- introducing Svelte stores

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/design-refactoring-editor-api-client.md`
- `design-docs/specs/design-refactoring-editor-data-loaders.md`
- `ui/src/App.svelte`
