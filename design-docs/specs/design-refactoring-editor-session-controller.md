# Editor Session Controller Refactoring

This document records the session-orchestration refactoring slice introduced during the Svelte-to-Solid migration and retained in the checked-in SolidJS editor.

## Overview

The overall local-server plus replaceable-frontend architecture still matches the intended purpose. During the migration, the top-level session orchestration layer drifted because two app shells owned the same behavior:

- `ui/src/App.svelte` and `ui/src/App.tsx` both owned workflow-session refresh/select/execute/cancel flows
- selected-session polling behavior has already diverged between the two app shells
- timer ownership is correctly kept in the component layer, but the command sequencing and retry policy are duplicated

That duplication was a migration risk because the final SolidJS cutover was supposed to replace framework glue, not re-implement session behavior separately.

## Intended Boundary

Introduce a framework-neutral session-controller helper under `ui/src/lib/` that centralizes session-panel command flows. That helper was adopted by both migration-era app shells and remains part of the checked-in Solid runtime.

Responsibilities of the new helper:

- compose existing `editor-actions` session APIs into one shared command boundary
- shape session-panel updates so both frontends apply the same data contract
- make selected-session polling retry semantics explicit and testable
- keep execution/cancel/session-refresh result handling aligned across frameworks

Responsibilities that remain in the app shell:

- timer allocation and cleanup
- busy/loading flag ownership
- DOM event wiring
- framework-specific state application
- read-only / no-exec guards that depend on local component state

## Why This Boundary

The existing `editor-actions` module already centralizes transport-level orchestration, but both top-level apps still repeat the component-facing session logic that sits immediately above it. That layer is where migration drift has shown up.

By extracting a shared session controller:

- both migration-era frontends consume the same selected-session polling policy
- transient polling failures keep retry behavior consistent during the migration
- execution/session behavior can be verified once with focused unit tests
- the eventual SolidJS cutover removes more framework-specific glue instead of copying it

## Expected Module Shape

Target module:

- `ui/src/lib/editor-session-controller.ts`

Expected capabilities:

- return framework-neutral session-panel updates for refresh/select/execute/cancel flows
- return a discriminated polling result so callers can either apply fresh state or reschedule polling after transient failures
- optionally patch `EditorAppShellData` in the staged Solid path without duplicating ad-hoc object reconstruction

## Non-Goals

- moving polling timers out of the components
- replacing `editor-actions.ts`
- converting the checked-in Svelte entrypoint to SolidJS in this slice
- changing API routes or session payload semantics

## References

- `design-docs/specs/design-workflow-web-editor.md`
- `design-docs/specs/design-refactoring-editor-action-helpers.md`
- `ui/src/App.tsx`
