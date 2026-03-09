# Server Workflow Bundle Parsing Refactoring

This document defines the next server-side refactoring slice for browser workflow bundle save and validate requests.

## Overview

The current architecture still matches the intended local-server plus replaceable-frontend design, but `src/server/api.ts` still owns ad hoc workflow bundle request parsing for save and validate routes.

That remaining inline parsing has two maintainability problems:

- route handlers still mix routing/orchestration with workflow bundle shape normalization
- the current `typeof value === "object"` checks are weaker than the intended JSON-object contract and can admit array-shaped payload sections

## Decision

Introduce a dedicated server-owned helper module for browser workflow bundle request parsing and validation remapping.

Target module:

- `src/server/api-workflow-bundle.ts`

## Intended Boundary

The extracted helper owns:

- parsing save request bodies into validated workflow bundle payloads
- distinguishing missing bundle bodies from malformed bundle bodies
- strict JSON-object checks for `bundle`, `bundle.workflow`, `bundle.workflowVis`, and `bundle.nodePayloads`
- validation-time node-payload remapping from browser node ids to persisted node-file keys

`src/server/api.ts` remains responsible for:

- route matching
- access-mode checks
- load/save/validate orchestration
- HTTP status code selection
- transport response shaping

## Why This Boundary

This is a safe continuation of the existing server refactor:

- it removes a remaining mixed-responsibility hotspot from the API router
- it tightens request-boundary type safety without changing the persisted workflow model
- it makes malformed browser bundle payload handling explicit and testable
- it keeps the server architecture aligned with the documented helper-oriented route design

## Non-Goals

- redesigning workflow JSON schemas
- changing frontend request formats
- decomposing all remaining route handlers in `src/server/api.ts`

## References

- `design-docs/specs/architecture.md`
- `design-docs/specs/design-refactoring-investigation-plan.md`
- `src/server/api.ts`
