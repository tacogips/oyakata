# Workflow Design QA

**Status**: Confirmed (canonical decisions recorded)
**Created**: 2026-02-23

## Confirmed Decisions (from user)

1. Workflow location
- Workflows are stored under `.oyakata/` in subdirectories.
- Unit path: `.oyakata/<workflow-name>/`.

2. Required files per workflow
- `workflow.json`
- `workflow-vis.json`
- `node-{id}.json` (one file per node)

3. workflow.json role
- Must include `description` describing workflow purpose.
- Defines node combinations, branching, and looping structure.

4. node-{id}.json role
- Defines runtime execution payload for each node:
  - `executionBackend`
  - `promptTemplate`
  - `model`
  - `variables`

5. workflow-vis.json role
- Stores browser visualization state (e.g., node `order`).
- `indent`/`color` are derived from graph and loop/group semantics at render time.
- Updated by browser operations.

6. Branch match policy
- When multiple branch conditions are true, execute all matched branches (fan-out).

7. Loop safety default
- If loop-local limits are omitted, apply global default value.

8. Completion requirement
- Auto-complete nodes are allowed.
- Nodes without explicit success judgment are allowed by node configuration.

9. Timeout requirement
- Node execution timeout should be configurable.
- Design includes node-level timeout override plus workflow-level default timeout.
 
10. Initial default values
- `defaults.maxLoopIterations = 3`
- `defaults.nodeTimeoutMs = 120000`

## Canonical Decisions (Resolved)

1. Node payload field names
- Canonical fields are `promptTemplate` and `variables`.
- Legacy aliases `prompt` and `variable` are read-compatible only.
- Writers/normalizers must output canonical field names.

2. `model` requiredness
- `node-{id}.json.model` is required for validation and runtime execution.
- `node-{id}.json.executionBackend` is the canonical execution interface field for newly authored workflows.
- Existing workflows may omit `executionBackend` only when `model` is a tacogips legacy backend identifier.
- `OYAKATA_DEFAULT_MODEL` is only for interactive/template generation convenience.
- Workflows missing `model` must fail validation.

3. Completion semantics
- Completion is optional.
- Missing `completion` or `completion.type = "none"` means auto-complete behavior.
- Explicit completion strategies (`checklist`, `score-threshold`, `validator-result`) apply quality gates.

4. Node id format
- Node id is a stable slug-like identifier, not limited to short UUID.
- Recommended validation pattern: `^[a-z0-9][a-z0-9-]{1,63}$`.
- `node-{id}.json` naming remains required.

5. Artifact root policy
- Artifact root is configurable and independent of workflow definition root.
- Resolution order:
  1. CLI `--artifact-root`
  2. `OYAKATA_ARTIFACT_ROOT`
  3. `./.oyakata/workflow` (default)
- Artifact path format remains `{artifact-root}/{workflow_id}/executions/{workflowExecutionId}/nodes/{node}/{node-exec-id}/`.
