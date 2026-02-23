# Workflow Design QA

**Status**: Fully confirmed
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
  - `prompt`
  - `model`
  - `variable`

5. workflow-vis.json role
- Stores browser visualization state (e.g., node `x`, `y`).
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
