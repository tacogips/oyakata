# Refactoring Investigation Plan

This document defines the investigation plan for a repository-wide refactoring effort.

## Overview

The goal is to build an evidence-based refactoring roadmap for the current codebase, with emphasis on:

- eliminating unnecessarily verbose code
- reducing avoidable hardcoding
- strengthening type safety
- unifying naming
- improving DRYness
- aligning modules and abstractions with SOLID-style responsibilities
- increasing long-term maintainability and refactor safety

This document covers investigation only. It does not authorize implementation changes by itself.

## Investigation Scope

The investigation covers the current TypeScript/Bun server/runtime code, CLI/TUI code, and browser frontend code under `ui/`.

Frontend transition note:
- the checked-in browser implementation is still Svelte today
- the active migration target is SolidJS
- investigation and follow-up refactoring plans should therefore distinguish between current-state Svelte hotspots and framework-agnostic browser/editor boundaries that must survive the cutover

Primary initial hotspots identified from the repository scan:

- `src/workflow/engine.ts`
- `src/server/api.ts`
- `src/workflow/validate.ts`
- `src/cli.ts`
- `ui/src/App.svelte` (current checked-in frontend hotspot prior to SolidJS cutover)

Cross-cutting concerns already visible:

- duplicated domain types between backend and UI
- broad use of `Record<string, unknown>` in places where narrower types may be possible
- cast-heavy parsing and normalization paths
- large modules mixing domain logic with transport or presentation concerns

## Investigation Principles

- Prefer evidence from the current codebase over generic refactoring advice.
- Separate discovery from implementation to avoid premature code churn.
- Prioritize changes that improve maintainability without destabilizing workflow/runtime behavior.
- Treat type-safety improvements as architectural changes when they affect API or domain contracts.
- Produce outputs that can be executed in small, reviewable refactoring batches.

## Multi-Pass Investigation Plan

### Pass 1: Architecture and Responsibility Mapping

Objective:
- map major module boundaries
- identify mixed responsibilities
- locate dependency-direction problems
- identify files that violate single-responsibility expectations

Primary targets:
- `src/workflow/engine.ts`
- `src/server/api.ts`
- `src/cli.ts`
- `src/lib.ts`
- `ui/src/App.svelte` (or its SolidJS replacement entry once the cutover lands)

Expected outputs:
- module responsibility map
- dependency and boundary notes
- candidate files for decomposition

### Pass 2: Domain Model and Type-Safety Audit

Objective:
- identify duplicated domain types and protocol shapes
- find weak object typing and unsafe casts
- detect inconsistent optionality and naming in core domain models
- evaluate where discriminated unions or shared exported types should replace ad hoc local definitions

Primary targets:
- `src/workflow/types.ts`
- `src/workflow/session.ts`
- `src/workflow/validate.ts`
- `src/workflow/input-assembly.ts`
- `ui/src/App.svelte` (or the matching SolidJS app shell after cutover)

Expected outputs:
- shared type unification candidates
- ranked list of unsafe type patterns
- proposed boundaries between validation types, runtime types, and UI DTOs

### Pass 3: Complexity and Decomposition Audit

Objective:
- identify oversized files and functions
- examine branch density and hidden state transitions
- locate code paths where IO, orchestration, and domain logic are coupled
- derive a safe extraction order for large modules

Primary targets:
- `src/workflow/engine.ts`
- `src/server/api.ts`
- `src/workflow/validate.ts`
- `ui/src/App.svelte` (or the matching SolidJS app shell after cutover)

Expected outputs:
- complexity hotspots
- extraction candidates
- decomposition sequence with dependency notes

### Pass 4: DRY, Naming, and Utility Consolidation Audit

Objective:
- find repeated helpers and repeated parsing/serialization logic
- find repeated literals, conventions, and shape conversions
- identify inconsistent naming across CLI, API, runtime, persistence, and UI

Primary targets:
- cross-cutting scan across `src/` and `ui/src/`

Expected outputs:
- duplicate-code matrix
- naming normalization candidates
- utility extraction candidates

### Pass 5: Hardcoding and Configuration Audit

Objective:
- classify hardcoded defaults, paths, constants, status strings, content types, timing values, and behavior flags
- distinguish true invariants from values that should be promoted to shared constants or configuration

Primary targets:
- `src/workflow/types.ts`
- `src/server/api.ts`
- `src/cli.ts`
- `ui/src/App.svelte` (or the matching SolidJS app shell after cutover)

Expected outputs:
- hardcoded-value inventory
- classification table:
  - leave as invariant
  - promote to constant
  - promote to config

### Pass 6: Test-Safety and Refactor Sequencing Audit

Objective:
- evaluate whether current tests protect behavior during refactoring
- identify where characterization tests are needed before structural changes
- determine which refactors can be parallelized and which require dependency ordering

Primary targets:
- hotspot-adjacent `*.test.ts` files

Expected outputs:
- refactor safety gaps
- characterization test recommendations
- sequencing guidance by risk level

### Pass 7: Final Synthesis

Objective:
- merge all findings into one actionable refactoring roadmap

Expected outputs:
- prioritized backlog
- suggested execution order
- risk and dependency notes
- recommended PR granularity

## Investigation Rounds

To keep the work reviewable, run the investigation in these rounds:

1. Round 1
- Pass 1: Architecture and Responsibility Mapping
- Pass 2: Domain Model and Type-Safety Audit

2. Round 2
- Pass 3: Complexity and Decomposition Audit
- Pass 4: DRY, Naming, and Utility Consolidation Audit

3. Round 3
- Pass 5: Hardcoding and Configuration Audit
- Pass 6: Test-Safety and Refactor Sequencing Audit

4. Round 4
- Pass 7: Final Synthesis

## Deliverables Per Round

Each round should produce:

- a short findings summary
- a list of concrete code references
- severity or priority labels where appropriate
- explicit separation between observed facts and proposed refactors
- open questions that materially affect later implementation planning

## Definition of Done

The investigation is complete when:

- each major module has an explicit responsibility assessment
- major duplicated type definitions and unsafe typing patterns are cataloged
- major hardcoded policies/defaults are classified
- major decomposition opportunities are prioritized
- test coverage risks for refactoring are identified
- the final roadmap can be executed in small, reviewable refactoring batches

## Non-Goals

- implementing refactors during the investigation phase
- changing public behavior without a separate implementation decision
- performing speculative rewrites without repository evidence

## References

- `design-docs/specs/notes.md`
- `design-docs/specs/architecture.md`
