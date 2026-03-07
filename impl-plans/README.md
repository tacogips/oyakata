# Implementation Plans

This directory contains implementation plans that translate design documents into actionable implementation specifications.

## Purpose

Implementation plans bridge design documents (what to build) and actual code (how to build). They provide:
- Clear deliverables without code
- Interface and function specifications
- Dependency mapping for concurrent execution
- Progress tracking across sessions

## Directory Structure

```
impl-plans/
├── README.md
├── PROGRESS.json
├── active/
├── completed/
└── templates/
```

## Active Plans

| Plan | Status | Design Reference | Last Updated |
|------|--------|------------------|--------------|
| `workflow-web-editor-execution` | In Progress | `design-workflow-web-editor` | 2026-03-07 |

## Completed Plans

| Plan | Completed | Design Reference |
|------|-----------|------------------|
| `workflow-core-and-validation` | 2026-02-23 | `design-data-model`, `design-workflow-json`, `architecture` |
| `workflow-cli-mvp` | 2026-02-23 | `command`, `design-workflow-json` |
| `workflow-execution-and-session` | 2026-02-24 | `architecture`, `command` |
| `workflow-serve-mvp` | 2026-02-23 | `design-workflow-web-editor`, `architecture`, `command` |
| `workflow-vcs-handoff-checkpoints` | 2026-02-23 | `architecture`, `design-vcs-handoff-checkpoints` |
| `workflow-save-revision-api` | 2026-02-24 | `design-workflow-web-editor` |
| `workflow-deterministic-mock-and-rerun` | 2026-02-24 | `architecture`, `command` |
| `autonomous-execution-gap-closure` | 2026-02-24 | `design-autonomous-execution-gap-closure` |
| `workflow-tui-mvp` | 2026-02-25 | `design-tui` |
| `workflow-tui-cli-parity` | 2026-02-25 | `design-tui` |
| `workflow-tui-resume-decoupling` | 2026-02-25 | `design-tui` |
| `node-execution-backend-selection` | 2026-03-07 | `architecture` |
| `node-output-contract-and-validation` | 2026-03-07 | `design-node-output-contract`, `design-data-model`, `architecture` |
| `oyakata-manager-prompt-contract` | 2026-03-07 | `design-oyakata-manager-prompt-contract`, `architecture` |
| `node-session-reuse` | 2026-03-07 | `design-node-session-reuse`, `architecture`, `design-data-model` |
| `node-backend-model-separation` | 2026-03-07 | `design-node-backend-model-separation`, `design-data-model`, `design-workflow-json`, `architecture` |

## Phase Dependencies

| Phase | Status | Depends On |
|-------|--------|------------|
| 1 | COMPLETED | - |
| 2 | COMPLETED | Phase 1 |
| 3 | COMPLETED | Phase 2 |
| 4 | COMPLETED | Phase 3 |
| 5 | COMPLETED | Phase 4 |
| 6 | COMPLETED | Phase 5 |
| 7 | COMPLETED | Phase 6 |
| 8 | COMPLETED | Phase 7 |
| 9 | COMPLETED | Phase 8 |
| 10 | COMPLETED | Phase 9 |
| 11 | COMPLETED | Phase 10 |
| 12 | COMPLETED | Phase 11 |
| 13 | COMPLETED | Phase 12 |
| 14 | IN_PROGRESS | Phase 13 |
| 15 | COMPLETED | Phase 14 |
| 16 | COMPLETED | Phase 15 |
| 17 | COMPLETED | Phase 16 |

### Phase to Plans Mapping

```
PHASE_TO_PLANS = {
  1: ["completed/workflow-core-and-validation.md"],
  2: ["completed/workflow-cli-mvp.md"],
  3: ["completed/workflow-execution-and-session.md"],
  4: ["completed/workflow-serve-mvp.md"],
  5: ["completed/workflow-vcs-handoff-checkpoints.md"],
  6: ["completed/workflow-save-revision-api.md"],
  7: ["completed/workflow-deterministic-mock-and-rerun.md"],
  8: ["completed/autonomous-execution-gap-closure.md"],
  9: ["completed/workflow-tui-mvp.md"],
  10: ["completed/workflow-tui-cli-parity.md"],
  11: ["completed/workflow-tui-resume-decoupling.md"],
  12: ["impl-plans/node-execution-backend-selection.md"],
  13: ["impl-plans/node-output-contract-and-validation.md"],
  14: ["impl-plans/workflow-web-editor-execution.md"],
  15: ["impl-plans/oyakata-manager-prompt-contract.md"],
  16: ["impl-plans/node-session-reuse.md"],
  17: ["impl-plans/node-backend-model-separation.md"]
}
```
