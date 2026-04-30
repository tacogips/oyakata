# Workflow Supervisor Dispatcher Implementation Plan

**Status**: Ready
**Design Reference**: `design-docs/specs/design-workflow-supervisor-dispatcher.md`
**Created**: 2026-04-30
**Last Updated**: 2026-04-30

## Related Plans

- **Current Plan**: `impl-plans/workflow-supervisor-dispatcher.md`
- **Next**: `impl-plans/workflow-supervisor-dispatcher-foundation.md`
- **Next**: `impl-plans/workflow-supervisor-dispatcher-runtime.md`
- **Previous**: `impl-plans/completed/event-supervisor-control-foundation.md`
- **Previous**: `impl-plans/completed/supervisor-natural-language-control.md`
- **Related**: `impl-plans/completed/event-external-mailbox-binding-foundation.md`

## Design Document Reference

**Source**: `design-docs/specs/design-workflow-supervisor-dispatcher.md`,
`design-docs/specs/design-event-supervisor-control.md`,
`design-docs/specs/design-event-external-mailbox-binding.md`,
`design-docs/specs/architecture.md#event-listener-workflow-triggers`

### Summary

Implement chat-facing multi-workflow supervision on top of the existing
single-target supervised flow. External input should enter one supervisor
conversation, resolve to a structured dispatch decision, and apply lifecycle
changes only after validation, idempotency, and compare-and-swap checks.

### Scope

**Included**: supervisor profile schema/validation, dispatcher decision
contract, conversation persistence, runtime dispatch service, event routing,
GraphQL/library entrypoints, examples, and focused tests.

**Excluded**: long-lived resumed supervisor executions, profile migration
commands, direct-answer external tool calls, and TUI-specific UX.

### Delivery Breakdown

The original unresolved TODOs are now split into execution-ready plans:

| Original TODO | Split Plan | Task |
|---------------|------------|------|
| line 99: supervisor profile types and validation | `workflow-supervisor-dispatcher-foundation.md` | `TASK-001` |
| line 155: dispatch decision contract and resolver context | `workflow-supervisor-dispatcher-foundation.md` | `TASK-002` |
| line 228: supervisor conversation persistence | `workflow-supervisor-dispatcher-foundation.md` | `TASK-003` |
| line 272: runtime dispatch service and scoped capabilities | `workflow-supervisor-dispatcher-runtime.md` | `TASK-004` |
| line 301: event binding routing for `supervisor-dispatch` | `workflow-supervisor-dispatcher-runtime.md` | `TASK-005` |
| line 337: GraphQL and library dispatcher entrypoints | `workflow-supervisor-dispatcher-runtime.md` | `TASK-006` |
| line 349: examples and focused test coverage | `workflow-supervisor-dispatcher-runtime.md` | `TASK-007` |

## Dependencies

| Plan | Depends On | Status |
|------|------------|--------|
| `workflow-supervisor-dispatcher-foundation` | completed supervisor/event foundation plans | READY |
| `workflow-supervisor-dispatcher-runtime` | `workflow-supervisor-dispatcher-foundation` | BLOCKED |

## Completion Criteria

- [ ] Foundation types, validation, decision parsing, and persistence are
      specified in a dedicated execution plan
- [ ] Runtime dispatch, event routing, GraphQL/library surface, and verification
      are specified in a dedicated execution plan
- [ ] Every unresolved dispatcher TODO is mapped to a task with deliverables,
      dependencies, and completion criteria

## Progress Log

### Session: 2026-04-30 00:00
**Tasks Completed**: Authored initial implementation plan for workflow
supervisor dispatcher
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Chosen first-cut baseline is short-lived decision executions with a
pinned supervisor-profile snapshot and new multi-run conversation persistence,
while preserving the existing single-target supervised path for compatibility.

### Session: 2026-04-30 00:00 (review follow-up)
**Tasks Completed**: Reviewed and tightened the implementation plan against the
updated dispatcher design
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Filled missing concrete types for direct-answer/concurrency/lifecycle
policy, made compare-and-swap and source-message dedupe explicit in repository
contracts, aligned the plan with `runAlias` and
`selectedManagedRunIdsByWorkflowKey`, corrected the related-plan path, and
renamed the example target to `default-supervisor-dispatcher`.

### Session: 2026-04-30 00:00 (task split)
**Tasks Completed**: Split the oversized umbrella plan into foundation and
runtime execution plans
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Converted the unresolved dispatcher TODO list into concrete task IDs
and moved implementation detail into split plans so each file stays within the
repository impl-plan size guidance.

### Session: 2026-04-30 00:30 (architecture review feedback)
**Tasks Completed**: Reviewed the current dispatcher-plan diff against the
shipped event/supervisor architecture and recorded follow-up feedback
**Tasks In Progress**: None
**Blockers**: None
**Notes**:
- The current architecture does not yet match the intended dispatcher purpose.
  The shipped event path is still shaped around a single binding-owned target
  workflow or a single supervised target chosen before dispatch, while the
  dispatcher design requires late target selection inside a supervisor-owned
  multi-run conversation.
- Add a new dispatcher example bundle instead of renaming
  `examples/default-superviser/`; the existing bundle is still referenced by
  the nested auto-improve superviser path, tests, and docs.
- Add an explicit binding-contract task for `src/events/types.ts` and
  `src/events/validate.ts`, plus loader updates in `src/events/config.ts`;
  today `EventExecutionMode` only supports `"direct"` / `"supervised"`,
  `EventWorkflowExecutionPolicy` has no `supervisorProfileId`,
  `EventBinding.workflowName` is required, `asBinding()` rejects missing
  `workflowName` before validation, and binding validation always resolves that
  workflow name, but the dispatcher design requires
  `execution.mode = "supervisor-dispatch"`,
  `execution.supervisorProfileId`, and optional `workflowName`.
- Add an explicit mailbox-bridge follow-up for
  `src/events/mailbox-bridge-policy.ts` and the related validation path; the
  current architecture only treats `execution.mode = "supervised"` as
  supervisor-owned input/output, so dispatcher bindings would otherwise fall
  back to `direct-workflow`, which conflicts with the external mailbox design.
- Add an explicit trigger-runner follow-up for `src/events/trigger-runner.ts`
  and related receipt/result semantics. The current event path still assumes
  `binding.workflowName` exists before dispatch for duplicate/skipped/failed
  returns and for the direct execution branch, but dispatcher mode intentionally
  defers target workflow selection until after the supervisor decision. The
  next plan revision should define what `WorkflowTriggerResult.workflowName`,
  receipt payloads, and sticky-session behavior mean before a managed target is
  chosen.
- Reflect those architecture mismatches in the split-plan deliverables instead
  of leaving them implicit. `workflow-supervisor-dispatcher-foundation.md`
  `TASK-001` currently omits `src/events/config.ts`, and
  `workflow-supervisor-dispatcher-runtime.md` `TASK-005` currently omits
  `src/events/ledger.ts` and `src/events/receipt-ops.ts` even though replay,
  receipt persistence, and listener response payloads all depend on the new
  dispatcher result shape.
- Keep plan tracking coherent when the split lands: the umbrella plan and
  `impl-plans/README.md` now point at
  `workflow-supervisor-dispatcher-foundation.md` and
  `workflow-supervisor-dispatcher-runtime.md`, but those files are still
  untracked in the current working tree and `impl-plans/PROGRESS.json` has no
  corresponding entries even though repository guidance treats it as the status
  source of truth.
- Avoid keeping three active plans for the same scope. If the split is the new
  source of truth, the umbrella plan should become a review/index document or
  otherwise stop presenting itself as a separate ready-to-execute active plan in
  `impl-plans/README.md`.
- Define one canonical direct-answer policy field, or an explicit precedence
  rule, before validation and runtime behavior are implemented. The design text
  uses default-policy language like `allowDirectAnswer = true`, while the
  example profile shape uses `directAnswerPolicy.enabled` and
  `allowedDecisionKinds`.
- Recommended next implementation order for the next iteration: first land the
  event-binding schema changes (`supervisor-dispatch`, optional
  `workflowName`, required `supervisorProfileId`), then mailbox-bridge
  ownership/defaults, then conversation/persistence contracts, and only after
  that wire runtime dispatch, GraphQL, and packaged examples.

### Session: 2026-04-30 00:45 (architecture review refinement)
**Tasks Completed**: Verified the review feedback against the current source
tree and added concrete follow-up items that were still implicit
**Tasks In Progress**: None
**Blockers**: None
**Notes**:
- The current architecture mismatch is confirmed in code, not just in the
  design: `src/events/config.ts` still rejects bindings without
  `workflowName`, `src/events/validate.ts` still validates every binding
  against a concrete workflow name, and `src/events/types.ts` still limits
  `EventExecutionMode` to `"direct"` / `"supervised"`.
- The dispatcher split should explicitly treat current
  `supervisor-intent` / `supervisor-llm-resolver` behavior as single-target
  only. Both paths currently derive or validate one target from
  `binding.workflowName`, so `TASK-002` is not a small extension of the
  shipped contract; it is a deliberate contract generalization away from
  target-name equality with the binding itself.
- Add dispatcher receipt/index plumbing to the plan, not just trigger routing.
  `src/workflow/runtime-db.ts`, `src/events/ledger.ts`,
  `src/events/receipt-ops.ts`, and `src/events/listener-service.ts` currently
  expose only `workflowExecutionId`, `supervisedRunId`, and
  `supervisorExecutionId`. The dispatcher design also needs a durable
  `supervisorConversationId` and likely a `supervisorDecisionId` so replay,
  inspection, and webhook/listener responses can point at the supervisor-owned
  conversation before or even without a selected target execution.
- The split-plan deliverables should reflect those storage and surface changes
  explicitly:
  `workflow-supervisor-dispatcher-foundation.md` `TASK-003` should mention
  `src/workflow/runtime-db.ts` receipt-index shape changes alongside the new
  conversation repository, and `workflow-supervisor-dispatcher-runtime.md`
  `TASK-005` should mention `src/events/ledger.ts`,
  `src/events/receipt-ops.ts`, and listener response shaping alongside
  `trigger-runner.ts`.
- The umbrella-plan review should keep the example guidance strict: the new
  dispatcher example should be additive. `examples/default-superviser/` is
  still the documented nested auto-improve bundle, and the repository
  references that exact path in `examples/README.md` and
  `examples/auto-improve/README.md`.
- `impl-plans/PROGRESS.json` still has no dispatcher entries at all, while
  `impl-plans/README.md` now lists three active dispatcher plans. If the split
  remains, the next planning iteration should update the progress tracker in
  the same change set or clearly state that the tracker update is intentionally
  deferred.

### Session: 2026-05-01 (foundation implementation start)
**Tasks Completed**: Split-plan foundation work started: `supervisor-dispatch`
execution mode, optional binding `workflowName`, `supervisors/` profile loading
and validation, dispatcher proposal contract, mailbox defaults for dispatch
mode, trigger-runner guard for dispatch until runtime wiring.
**Tasks In Progress**: Foundation TASK-003; runtime plan TASK-004+
**Blockers**: None
**Notes**: Umbrella plan remains the index; execution detail lives in
`workflow-supervisor-dispatcher-foundation.md` and
`workflow-supervisor-dispatcher-runtime.md`.
