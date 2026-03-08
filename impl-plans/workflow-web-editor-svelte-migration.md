# Workflow Web Editor Svelte Migration Implementation Plan

**Status**: In Progress
**Design Reference**: design-docs/specs/design-workflow-web-editor.md#migration-strategy
**Created**: 2026-03-08
**Last Updated**: 2026-03-08

---

## Design Document Reference

**Source**: design-docs/specs/design-workflow-web-editor.md

### Summary
Replace the current inline browser editor with a standalone Svelte frontend without breaking `oyakata serve` during the migration.

### Scope
**Included**: frontend asset boundary in the server, Svelte app bootstrap, phased browser feature porting, parity-driven cutover.
**Excluded**: remote collaboration, websocket transport, backend API redesign beyond frontend bootstrap needs.

---

## Modules

### 1. Frontend Asset Serving

#### src/server/api.ts

**Status**: IN_PROGRESS

```typescript
interface UiConfigResponse {
  readonly fixedWorkflowName: string | null;
  readonly readOnly: boolean;
  readonly noExec: boolean;
  readonly frontend: "legacy-inline" | "svelte-dist";
}

interface StaticUiAsset {
  readonly contentType: string;
  readonly body: string | Uint8Array;
}
```

**Checklist**:
- [x] Add `GET /api/ui-config`
- [x] Add `ui/dist` static asset serving support
- [x] Keep legacy inline fallback while Svelte build output is absent
- [ ] Remove legacy inline fallback after Svelte parity

### 2. Svelte Frontend Bootstrap

#### ui/src/App.svelte

**Status**: COMPLETED

```typescript
interface UiConfig {
  readonly fixedWorkflowName: string | null;
  readonly readOnly: boolean;
  readonly noExec: boolean;
  readonly frontend: "legacy-inline" | "svelte-dist";
}

interface WorkflowListResponse {
  readonly workflows: readonly string[];
}
```

**Checklist**:
- [x] Add standalone Svelte app scaffold under `ui/`
- [x] Load UI config from `/api/ui-config`
- [x] Load workflow list and workflow details
- [x] Load session summaries for the selected workflow
- [x] Port save/validate/edit interactions
- [x] Port execution controls and status polling
- [x] Align frontend build tooling so repository-root commands still build to `ui/dist`

### 3. Verification

#### src/server/api.test.ts

**Status**: IN_PROGRESS

```typescript
interface UiConfigExpectation {
  readonly frontend: "legacy-inline" | "svelte-dist";
  readonly readOnly: boolean;
  readonly noExec: boolean;
}
```

**Checklist**:
- [x] Cover UI config endpoint
- [x] Cover static `ui/dist` serving and fallback behavior
- [x] Add repository-level frontend type/build checks
- [x] Add explicit repository commands for server/UI typecheck split
- [x] Replace temporary plain-`tsc` UI verification with a Svelte-aware checker
- [ ] Add browser verification against built Svelte assets
- [ ] Add E2E coverage for the migrated Svelte flow

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Frontend asset serving | `src/server/api.ts` | IN_PROGRESS | `bun test src/server/api.test.ts src/server/serve.test.ts` passes |
| Svelte frontend bootstrap | `ui/src/App.svelte` | COMPLETED | `bun run typecheck:ui` passes; `vite build` emits `ui/dist`, but `bun run build:ui` does not terminate cleanly in this sandbox |
| Verification | `src/server/api.test.ts`, `e2e/workflow-web-editor.pw.cjs` | IN_PROGRESS | Server/API tests and `svelte-check` pass; Playwright spec exists, but local browser verification is blocked here because `oyakata serve` cannot bind `127.0.0.1` in this sandbox |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Svelte asset serving | `workflow-web-editor-execution:TASK-002` | Available |
| Svelte bootstrap app | Frontend asset serving | In Progress |
| Final cutover | Svelte bootstrap parity | Blocked |

## Completion Criteria

- [x] Design updated to describe phased Svelte migration
- [x] Implementation plan created
- [x] Server can serve built frontend assets when available
- [x] Svelte source tree exists and can consume current APIs
- [x] Svelte source covers editing, execution, session polling, and cancellation flows against the current API
- [x] Playwright E2E coverage exists for the migrated Svelte flow
- [ ] Root route defaults to Svelte in normal development flow
- [ ] Legacy inline UI removed
- [ ] Browser/E2E verification passes for the Svelte UI

## Progress Log

### Session: 2026-03-08 09:35
**Tasks Completed**: Plan creation, first migration slice design
**Tasks In Progress**: Frontend asset serving, Svelte bootstrap app
**Blockers**: The sandbox blocks `bun add` tempdir writes, so Svelte dependencies cannot be installed or built here during this session
**Notes**: The current design already targeted Svelte, but implementation was still an inline HTML/JS editor. This plan formalizes a non-breaking migration that introduces `ui/dist` serving plus a real `ui/` Svelte source tree before full cutover.

### Session: 2026-03-08 10:05
**Tasks Completed**: TASK-001, partial TASK-002, partial TASK-003
**Tasks In Progress**: TASK-002, TASK-003
**Blockers**: The sandbox still blocks Svelte dependency installation, so the new `ui/` app cannot be built or browser-verified here yet
**Notes**: Added `/api/ui-config`, `ui/dist` static asset serving with legacy fallback, a first Svelte source tree under `ui/`, and targeted API coverage for both bootstrap config and built-asset serving. `bun test src/server/api.test.ts src/server/serve.test.ts` and `bun run typecheck` pass.

### Session: 2026-03-08 12:10
**Tasks Completed**: Additional TASK-002 slice
**Tasks In Progress**: TASK-002, TASK-003
**Blockers**: Svelte dependencies are still unavailable in this sandbox, so the rewritten `ui/src/App.svelte` cannot be built or browser-verified here
**Notes**: Replaced the read-only Svelte bootstrap with a functional editor shell that loads editable workflow state, updates workflow description/defaults and node payload fields, validates via `POST /api/workflows/:name/validate`, saves via `PUT /api/workflows/:name` with revision conflict messaging, and refreshes workflow/session data through the existing API contract.

### Session: 2026-03-08 12:45
**Tasks Completed**: TASK-002
**Tasks In Progress**: TASK-003
**Blockers**: Svelte dependencies remain unavailable in this sandbox, so browser verification and final bundle cutover still cannot be executed here
**Notes**: Extended the Svelte UI to cover workflow execution via `POST /api/workflows/:name/execute`, selected-session inspection via `GET /api/sessions/:id`, cancellation via `POST /api/sessions/:id/cancel`, and polling of running sessions so the browser path now covers the critical serve-mode workflow loop.

### Session: 2026-03-08 13:20
**Tasks Completed**: Design/plan audit for the current diff
**Tasks In Progress**: TASK-003
**Blockers**: The repository verification path still does not validate `ui/`, and the Vite config currently lacks an explicit `ui/` project root even though the server expects build output in `ui/dist`
**Notes**: Static review found an architectural mismatch in the migration wiring rather than in the Svelte target itself. This iteration adds the missing build-contract alignment and repository-level frontend checks so the phased migration can be verified consistently once Svelte dependencies are installed.

### Session: 2026-03-08 13:45
**Tasks Completed**: Build-contract alignment, repository script wiring
**Tasks In Progress**: TASK-003
**Blockers**: `bun run build:ui` cannot be completed in this sandbox because the newly declared Svelte toolchain dependencies are not installed in the current root `node_modules`, so browser/E2E verification remains blocked
**Notes**: Set the Vite project root to `ui/`, aligned build output with the server’s `ui/dist` contract, switched Svelte bootstrapping to the Svelte 5 `mount(...)` API, and moved frontend dependency ownership to the repository root so the Bun workflow can eventually build and verify the frontend from standard root-level commands.

### Session: 2026-03-08 14:20
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Root/server verification still passes, but the sandboxed environment still does not produce a terminating `bun run build:ui`, so Svelte build verification and browser/E2E checks remain incomplete
**Notes**: Extended `ui/src/App.svelte` beyond payload-only editing by adding Svelte-side structure editing for manager selection, node creation/removal/reordering, node kind/completion updates, and edge/loop editing. Also fixed a migration bug where the new node creator accepted workflow-name syntax that the backend would reject for node ids.

### Session: 2026-03-08 15:05
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Targeted Bun tests and root `tsc --noEmit` pass, but the frontend toolchain still cannot be verified end-to-end here because `node_modules` does not contain installed `svelte` / `@sveltejs/vite-plugin-svelte` packages and `bunx vite build --config ui/vite.config.ts` does not complete cleanly in this sandbox
**Notes**: Reviewed the in-progress Svelte migration diff and found a concrete UI defect: workflow edits were mutating nested objects in place, so Svelte could miss unsaved-state and field refresh updates. Added a central edit-marker in `ui/src/App.svelte` so workflow, structure, and node-payload mutations now trigger component reactivity and clear stale validation results. Also declared `vite` directly in `package.json` so the frontend build contract does not rely on a transitive CLI.

### Session: 2026-03-08 16:10
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: `bun test src/server/api.test.ts src/server/serve.test.ts` and `bun run typecheck` pass, but `bun run build:ui` still does not terminate cleanly in this sandbox because the Svelte toolchain is not fully installed or runnable here
**Notes**: Tightened the serve-mode asset boundary so any exact built file under `ui/dist/` can be served for non-API requests instead of only `/assets/*`, which matches the intended static-bundle contract and prevents root-level frontend files from breaking. Also fixed a Svelte editor regression where changing node kind/backend/model/timeout could overwrite unsaved `variables` JSON text by unnecessarily resyncing the selected-node buffer.

### Session: 2026-03-08 17:05
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Server/API verification passes, but the Svelte toolchain is still not installed in this sandbox, so `ui/` cannot be built or browser-verified here
**Notes**: Closed a design-to-implementation gap in the browser execution contract by exposing canonical `/api/workflow-executions/:id` and `/cancel` routes, returning `workflowExecutionId` alongside legacy `sessionId` fields, and switching the Svelte client to those canonical execution endpoints while preserving compatibility aliases.

### Session: 2026-03-08 18:05
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: `bun test src/server/api.test.ts src/server/serve.test.ts` and root `tsc --noEmit` pass, but the Svelte toolchain is still missing in this sandbox (`node_modules` does not contain `svelte` or `@sveltejs/vite-plugin-svelte`), so `ui/` still cannot be built or browser-verified here
**Notes**: Reviewed the in-progress migration diff and fixed two concrete Svelte parity issues instead of changing the design target. The Svelte editor now recomputes derived vertical grouping/indent colors from local unsaved edits instead of showing stale server-loaded visualization, and it now exposes first-class sub-workflow editing (boundary nodes, owned-node membership, and input sources) so the frontend covers a core part of the real workflow model rather than only nodes/edges/loops. This iteration also hardens structure editing by cleaning sub-workflow references when nodes are removed and by preventing the root manager selector from offering nodes already reserved as sub-workflow boundaries.

### Session: 2026-03-08 18:35
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Server tests still pass, but `bun run build:ui` does not terminate cleanly in this sandbox, so Svelte build verification and browser verification remain blocked
**Notes**: Reviewed the current migration diff for continuation bugs and fixed a concrete structure-editor defect in `ui/src/App.svelte`: changing the root manager or sub-workflow boundaries could leave stale `root-manager`, `sub-manager`, `input`, or `output` kinds on unrelated nodes because role kinds were only assigned forward, never cleaned up. The editor now recomputes all reserved structure kinds from current workflow state on every structure edit, which keeps UI state aligned with the backend workflow model. Also ignored generated `ui/dist/` output at the repository level so the new frontend build artifact does not pollute future migration diffs.

### Session: 2026-03-08 19:05
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Targeted server/API verification passes, but `bun run build:ui` and browser verification remain blocked in this sandbox because the Svelte toolchain is still not fully runnable here
**Notes**: Reviewed the existing migration diff for architectural continuation issues rather than changing the Svelte target itself. Fixed a concrete serve-mode bug in `src/server/api.ts` where the default built-asset root was derived from `process.cwd()`, which would break `oyakata serve` when launched outside the repository root or from an installed package layout. The default `ui/dist` root is now resolved relative to the module/package location, and a regression test covers both source-tree and built-package paths.

### Session: 2026-03-08 10:06
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Bun server tests and root `tsc --noEmit` still pass, but frontend-specific build/browser verification remains blocked in this sandbox because the Svelte toolchain is not terminating cleanly here
**Notes**: Reviewed the current Svelte migration diff for continuation bugs and fixed a client-side structure-editor consistency defect in `ui/src/App.svelte`. Renaming or removing sub-workflows could leave stale `subWorkflowId` references inside other sub-workflow input sources, so the Svelte editor now cascades rename/remove updates the same way the legacy inline editor does and resets orphaned sources back to `human-input` instead of preserving broken references.

### Session: 2026-03-08 10:09
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: `bun test src/server/api.test.ts src/server/serve.test.ts` and `timeout 20s bun run typecheck` pass, but `timeout 20s bun run build:ui` still exits on timeout in this sandbox, so frontend bundle verification and browser verification remain incomplete

### Session: 2026-03-08 15:40
**Tasks Completed**: Review/verification baseline refresh
**Tasks In Progress**: TASK-003
**Blockers**: `bun test src/server/api.test.ts src/server/serve.test.ts src/workflow/engine.test.ts` and `bun run typecheck` pass. `vite build --config ui/vite.config.ts` emits `ui/dist`, but `bun run build:ui` still does not exit cleanly in this sandbox. Browser verification remains blocked here because direct `oyakata serve --host 127.0.0.1 --port 0` fails with `Failed to listen at 127.0.0.1`, so the bundled Playwright flow cannot complete in this environment.
**Notes**: The plan previously overstated the blocker as missing browser/E2E coverage. That is no longer accurate: the repository already contains `e2e/workflow-web-editor.pw.cjs`, and the remaining gap is environment/tooling execution rather than missing design or missing test intent.
**Notes**: Audited the in-progress Svelte migration against the canonical execution API contract and fixed a forward-compatibility defect in `ui/src/App.svelte`. The client now tracks selected executions by `workflowExecutionId` internally instead of mixing canonical endpoints with legacy `sessionId`-based local state, which keeps selection, polling, cancellation, and session highlighting aligned with the design even after the compatibility alias is eventually removed.

### Session: 2026-03-08 19:25
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Targeted server/API tests pass, but frontend verification is still blocked in this sandbox because `node_modules` does not contain the declared `svelte` toolchain, so `bun run typecheck:ui` fails with missing `svelte` type definitions and `bun run build:ui` still cannot complete here
**Notes**: Reviewed the current diff as a continuation task and found a repository-contract gap rather than a design mismatch. Added explicit `typecheck:server`, `typecheck:ui`, and `check:ui` commands, wired the task runner and README to those commands, and added the standard `ui/src/vite-env.d.ts` shim plus `ui/tsconfig.json` inclusion so the Svelte project has a correct standalone typecheck boundary once dependencies are installed.

### Session: 2026-03-08 20:05
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: The proper Svelte verification path is still blocked in this sandbox because `node_modules` lacks `svelte`, `@sveltejs/vite-plugin-svelte`, and `svelte-check`, so the UI cannot yet be validated with a real Svelte-aware checker or bundled for browser verification
**Notes**: Reviewed the migration as continuation work and fixed two concrete Svelte parity issues in `ui/src/App.svelte` rather than changing the Svelte target. The client now merges both `issues` and `warnings` from the validation API instead of silently dropping warnings whenever both arrays are returned, and it no longer exposes reserved structure node kinds (`root-manager`, `sub-manager`, `input`, `output`) as manually editable values even though those roles are derived from manager/sub-workflow structure. This session also updated the design docs to record that plain `tsc` is only a temporary placeholder and that TASK-003 still needs a Svelte-aware verification command once the toolchain can be installed.

### Session: 2026-03-08 20:35
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Server tests still pass, but frontend verification remains blocked in this sandbox because `node_modules` does not currently include the declared Svelte toolchain, so `svelte-check` and `vite build` cannot be executed successfully here yet
**Notes**: Reviewed the current diff as continuation work and found a remaining verification-contract mismatch rather than a design mismatch. Replaced the temporary plain-`tsc` UI verification command with `svelte-check`, declared that tool in the repository dev dependencies, and updated the architecture/design/README/task docs so the migration’s verification contract now matches the intended Svelte frontend boundary.

### Session: 2026-03-08 21:35
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: Legacy inline DOM assumptions in the Playwright spec had drifted from the Svelte UI, so end-to-end coverage was effectively stale until the spec was updated
**Notes**: Review of the current diff found that the renamed Playwright file still targeted the removed inline editor (`#editorStatus`, `#sessionLine`, old button labels), so the migrated Svelte flow was not actually covered. Updated `e2e/workflow-web-editor.pw.cjs` to exercise the current Svelte UI for workflow creation, save, async execution, session inspection, and cancellation using the current accessible labels and status surfaces.

### Session: 2026-03-08 23:05
**Tasks Completed**: Additional TASK-003 slice
**Tasks In Progress**: TASK-003
**Blockers**: `agent-browser` is available, but browser verification still cannot target the migrated Svelte bundle in this sandbox because `svelte-check` is missing from the installed toolchain and `ui/dist` cannot be produced from the current environment
**Notes**: Reviewed the current continuation diff against the canonical execution API contract and found a remaining regression-coverage gap rather than a design mismatch. Added API coverage for the legacy `GET /api/sessions/:id` and `POST /api/sessions/:id/cancel` aliases so the compatibility promise now has explicit regression protection while the UI migration remains in progress.

### Session: 2026-03-08 23:58
**Tasks Completed**: Verification-status audit for TASK-003 continuation
**Tasks In Progress**: TASK-003
**Blockers**: `bun test src/server/api.test.ts src/server/serve.test.ts`, `bun test src/workflow/engine.test.ts`, `bun run typecheck:server`, and `bun run typecheck:ui` now pass in this sandbox. `bun run build:ui` does emit `ui/dist/*`, but the `bun`/`vite` process does not terminate cleanly here, so browser verification still lacks a reliable finished build step.
**Notes**: This review corrected stale plan assumptions rather than changing the migration design. The current blocker is no longer missing Svelte dependencies or failing Svelte type checks; it is the non-terminating frontend build/serve path that still prevents a clean verify-fix browser loop.

### Session: 2026-03-09 00:20
**Tasks Completed**: Repository test-runner isolation fix for browser E2E specs
**Tasks In Progress**: TASK-003
**Blockers**: `bun test`, `bun run typecheck:server`, `bun run typecheck:ui`, and Playwright test discovery now succeed in this sandbox, but `timeout 20s bun run build:ui` still has to kill the `vite build` process after output emission, so browser verification remains blocked on the non-terminating UI build path rather than on missing coverage or broken test discovery.
**Notes**: Continuation review found that `bun test` was incorrectly picking up the Playwright E2E spec because it still used a generic `.spec.*` filename. The E2E file now uses a Playwright-specific `.pw.*` suffix and the Playwright config matches that suffix, restoring a clean separation between Bun/Vitest-style test runs and browser E2E execution.

### Session: 2026-03-08 13:20
**Tasks Completed**: Additional TASK-003 server-surface regression coverage
**Tasks In Progress**: TASK-003
**Blockers**: `bun run build:ui` still does not terminate cleanly in this sandbox, so browser verification remains blocked on the frontend build path rather than on missing static-asset/API coverage
**Notes**: Continuation review of the migration diff found that the new `ui/dist` asset-serving boundary had positive-path coverage but no regression for traversal attempts. Added a focused API test proving non-API static serving does not expose files outside `ui/dist`, while keeping the design and migration plan unchanged because the implementation already matched the intended local static-bundle contract.
