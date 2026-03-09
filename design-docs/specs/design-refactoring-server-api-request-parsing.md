# Server API Request Parsing Refactoring

This document defines the next safe refactoring slice for `src/server/api.ts`.

## Overview

The current product architecture still matches the intended local-server-plus-replaceable-frontend design. The mismatch is internal maintainability inside the server API layer.

`src/server/api.ts` still repeats cast-heavy JSON body normalization across multiple routes:

- workflow creation request parsing
- workflow save request parsing
- in-memory validation request parsing
- workflow execute request parsing
- workflow rerun request parsing

That repetition creates three concrete risks:

1. Route drift
- small differences in object, string, and numeric-field handling can appear accidentally between routes

2. Weak type boundaries
- `Record<string, unknown>` casts are repeated inline instead of being centralized in one server-owned parsing boundary

3. Review friction
- route handlers mix transport parsing with orchestration, which makes later server refactors harder to review safely

## Decision

Extract server-owned request-parsing helpers from `src/server/api.ts` into a focused module under `src/server/`.

The extracted module will own:

- JSON-object normalization from unknown request-body values
- optional string and number field extraction helpers
- shared workflow-run option parsing for execute and rerun routes

`src/server/api.ts` will remain responsible for:

- route matching
- authorization and mode gating
- workflow/session orchestration
- HTTP status selection
- response serialization

## Design Rules

1. The parsing helper stays server-owned.
It must remain under `src/server/` because it models HTTP request-body normalization rules for local API routes, not shared workflow-domain behavior.

2. The extraction is behavior-preserving for existing routes.
This slice is for DRYness, clearer naming, and tighter type boundaries, not route redesign.

3. Execute and rerun options share one parsing policy.
Fields such as `runtimeVariables`, `mockScenario`, `maxSteps`, `maxLoopIterations`, `defaultTimeoutMs`, and `dryRun` should be parsed once through shared helpers instead of repeated inline logic.

4. Verification is server-focused.
This slice does not require browser verification because it changes backend request parsing only.

## Intended Impact

- reduce responsibility concentration in `src/server/api.ts`
- centralize repeated request-body normalization logic
- improve type-safety around server route parsing
- make later API decomposition safer

## Out of Scope

- changing public API routes
- changing workflow execution semantics
- frontend/editor refactoring
- server/router framework migration

## References

- `design-docs/specs/design-refactoring-investigation-plan.md`
- `design-docs/specs/architecture.md`
- `src/server/api.ts`
