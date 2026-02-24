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
| `autonomous-execution-gap-closure` | Ready | `design-autonomous-execution-gap-closure` | 2026-02-24 |

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
| 8 | READY | Phase 7 |

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
  8: ["active/autonomous-execution-gap-closure.md"]
}
```
