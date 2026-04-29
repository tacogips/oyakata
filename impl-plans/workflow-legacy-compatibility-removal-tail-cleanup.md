# Workflow legacy compatibility removal (tail cleanup)

**Status**: Completed for nested superviser rerun parse surface (2026-04-29).

This handoff stub mirrors `impl-plans/completed/workflow-legacy-compatibility-removal-tail-cleanup.md` for stable links.

Parent tracker:

- `impl-plans/workflow-legacy-compatibility-removal.md`

## Completion (2026-04-29 follow-up)

The remaining live residue called out in the prior snapshot is resolved: `parseRerunTargetWorkflowControlArguments` no longer contains a dedicated `rerunFromNodeId` branch. Nested `divedra/rerun-workflow` uses an **allowlist** of supported argument keys; any other key (including former node-addressed names) is rejected with a single generic error shape.

**Intentional guards (unchanged)**:

- `src/workflow/validate.ts` / `src/workflow/save.ts`: `REJECTED_AUTHORED_*` lists reject removed top-level keys (schema boundary enforcement).
- `src/workflow/manager-session-store.ts` / migration tests: on-disk SQLite upgrades from older column names.

**Optional hygiene for later iterations** (non-blocking):

- Grep `design-docs/` for sample `workflow.json` that still show removed fields; align with `entryStepId` + `steps[]` + `nodes[]` per `design-workflow-json.md`.
- Negative-test dedup across GraphQL / CLI / validate where assertions overlap.

After substantive cleanup slices, refresh this snapshot if you use it as a handoff note again.

## Iteration note (2026-04-29 follow-up review)

- Ran full `scripts/run-bun-tests.sh` (616 pass). No further live legacy shims found in `src/` beyond intentional validation strings and DB migration tests.
- `design-docs/` and `examples/` contain no sample `workflow.json` blocks with removed top-level keys (grep for quoted legacy keys).
- Corrected `workflow-legacy-compatibility-removal.md` review-matrix row that still described a `rewriteCallStepFailureMessage` mapping table after its removal; clarified handoff stub vs completed archive paths.
