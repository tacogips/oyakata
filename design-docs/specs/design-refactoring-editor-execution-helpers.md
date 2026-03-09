# Editor Execution Helpers Refactoring

This document defines the next refactoring slice for the Svelte workflow editor's execution form logic.

## Overview

The current product architecture still matches the intended local-server plus replaceable-frontend design, but `ui/src/App.svelte` still owns one concentrated block of pure execution-request assembly logic:

- runtime variable JSON parsing
- mock scenario JSON parsing
- positive-integer parsing for execution overrides
- optional request field inclusion rules for execute requests

That logic is pure and deterministic. Keeping it inline in the component makes the execution path harder to test in isolation and leaves `App.svelte` responsible for request-shape rules that are not inherently tied to Svelte state ownership.

## Intended Boundary

Introduce a frontend-owned execution helper module under `ui/src/lib/` that centralizes browser-side execution request assembly.

Responsibilities of the helper module:

- parse the execution form's JSON and numeric text fields
- assemble a typed `ExecuteWorkflowRequest`
- omit empty optional fields without changing current API behavior
- preserve current validation semantics for malformed JSON and malformed positive integers

Responsibilities that remain in `App.svelte`:

- busy/loading flags
- polling timer ownership
- success and error messages
- request dispatch
- DOM event handlers and Svelte-local state

## Why This Boundary

This boundary keeps `App.svelte` focused on orchestration while moving pure request-building rules into a reusable and directly testable module.

It also reduces the risk that later UI changes reintroduce:

- duplicated request assembly across execute/retry flows
- inconsistent integer parsing
- drift in which optional execution fields are sent to the API

## Expected Module Shape

Target module:

- `ui/src/lib/editor-execution.ts`

Expected capabilities:

- build a typed execute request from execution-form input text/flags
- expose a minimal helper interface that `App.svelte` can call without duplicating parsing rules

## Non-Goals

- changing server routes
- changing execution semantics
- moving polling timers out of the component
- redesigning rerun/cancel APIs
