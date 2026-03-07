# Workflow JSON Design

This document defines the JSON model for workflow orchestration and the required file layout.

## Overview

Workflow orchestration is split into multiple files under `<workflow-root>/<workflow-name>/` with explicit completion, branching, and loop semantics.

## Workflow Directory Structure

Required files per workflow:
- `workflow.json`
- `workflow-vis.json`
- `node-{id}.json` (one file per executable node, where `id` is a stable slug-like identifier)

Example:

```text
<workflow-root>/
  writing-session/
    workflow.json
    workflow-vis.json
    node-a1b2c3d4.json
    node-e5f6a7b8.json
```

Workflow root resolution:
1. CLI `--workflow-root`
2. `OYAKATA_WORKFLOW_ROOT`
3. `./.oyakata` (default)

Runtime execution artifacts are written outside the workflow definition directory:
- `{artifact-root}/{workflow_id}/executions/{workflowExecutionId}/nodes/{node}/{node-exec-id}/`

Path variable mapping:
- `{artifact-root}` resolution order:
  1. CLI `--artifact-root`
  2. `OYAKATA_ARTIFACT_ROOT`
  3. `./.oyakata/workflow` (default)
- `{workflow_id}` = `workflow.json.workflowId`

## workflow.json

`workflow.json` holds structural and control-flow definitions and must include:
- `description`: purpose of the workflow
- node graph and connectivity
- sub-workflow definitions for node sequences
- inter-sub-workflow conversation definitions
- conversation orchestration policy definitions
- mandatory `oyakata` manager node reference
- completion conditions
- branch definitions (including branch-judge node references)
- loop definitions (including loop-judge node references)
- global defaults (including loop limit and node timeout)
- references to `node-{id}.json`

Initial default values:
- `defaults.maxLoopIterations = 3`
- `defaults.nodeTimeoutMs = 120000`

Partial conceptual example (not copy-paste ready):
(illustrative fragment; node list and edge list are intentionally abbreviated for readability.)

```json
{
  "workflowId": "writing-session",
  "description": "Draft and review a document cooperatively.",
  "defaults": {
    "maxLoopIterations": 3,
    "nodeTimeoutMs": 120000
  },
  "managerNodeId": "oyakata-manager",
  "subWorkflows": [
    {
      "id": "writer-sw",
      "description": "Writer sequence.",
      "managerNodeId": "writer-sub-oyakata",
      "inputNodeId": "writer-input",
      "outputNodeId": "writer-output",
      "nodeIds": ["writer-sub-oyakata", "writer-input", "writer-draft", "writer-output"],
      "inputSources": [
        { "type": "human-input" }
      ]
    },
    {
      "id": "reviewer-sw",
      "description": "Reviewer sequence.",
      "managerNodeId": "reviewer-sub-oyakata",
      "inputNodeId": "reviewer-input",
      "outputNodeId": "reviewer-output",
      "nodeIds": ["reviewer-sub-oyakata", "reviewer-input", "reviewer-review", "reviewer-output"],
      "inputSources": [
        { "type": "sub-workflow-output", "subWorkflowId": "writer-sw" }
      ]
    }
  ],
  "subWorkflowConversations": [
    {
      "id": "writer-reviewer-dialog",
      "participants": ["writer-sw", "reviewer-sw"],
      "maxTurns": 6,
      "stopWhen": "reviewer_accepts || turns_exhausted"
    }
  ],
  "nodes": [
    {
      "id": "oyakata-manager",
      "name": "oyakata-manager",
      "description": "Coordinates sub-workflow execution.",
      "kind": "root-manager",
      "nodeFile": "node-oyakata-manager.json",
      "completion": {
        "type": "none"
      }
    },
    {
      "id": "a1b2c3d4",
      "name": "draft",
      "description": "Write the initial document draft.",
      "nodeFile": "node-a1b2c3d4.json",
      "completion": {
        "type": "checklist",
        "required": ["draft_created"]
      }
    },
    {
      "id": "e5f6a7b8",
      "name": "branch-check",
      "description": "Judge whether the draft needs review.",
      "kind": "branch-judge",
      "nodeFile": "node-e5f6a7b8.json",
      "completion": {
        "type": "validator-result"
      }
    }
  ],
  "edges": [
    { "from": "a1b2c3d4", "to": "e5f6a7b8", "when": "always" },
    { "from": "e5f6a7b8", "to": "review", "when": "needs_review" },
    { "from": "e5f6a7b8", "to": "done", "when": "skip_review" }
  ],
  "branching": {
    "mode": "fan-out"
  }
}
```

## node-{id}.json

Each `node-{id}.json` contains execution payload used at runtime:
- `id`: stable slug-like identifier matching `^[a-z0-9][a-z0-9-]{1,63}$`
- `name`: human-readable node name
- `description`: brief summary of the node's purpose
- `model` (`tacogips/codex-agent` or `tacogips/claude-code-agent`)
- `promptTemplate`
- `variables`
- optional `timeoutMs` (node execution timeout override)

Example:

```json
{
  "id": "a1b2c3d4",
  "name": "draft",
  "description": "Write the initial document draft.",
  "model": "tacogips/codex-agent",
  "timeoutMs": 90000,
  "promptTemplate": "Write draft for {{topic}}",
  "variables": {
    "topic": "workflow design"
  }
}
```

## workflow-vis.json

`workflow-vis.json` contains browser visualization state only, for example:
- vertical node order (`order`)
- optional UI metadata (`uiMeta`)

Derived at render time (not persisted):
- nesting depth (`indent`) for loop/group visualization
- semantic color token (`color`) for loop/group visualization

This file is updated by browser-side operations and should not define runtime execution semantics.

## Runtime Execution Artifact Output

Each node run produces one execution artifact directory:
- `{artifact-root}/{workflow_id}/executions/{workflowExecutionId}/nodes/{node}/{node-exec-id}/`

Artifact payload contract:
- `input.json`: resolved input payload used for this execution
- `output.json`: resulting output payload produced by node execution
- `meta.json`: runtime metadata (status, start/end timestamps, timeout/cancel result)

Input handoff rule:
- Downstream inputs are composed by `oyakata` manager using prior execution `output.json`.
- The resolved downstream payload must be persisted as that node execution's `input.json`.

## Branching and Loop Semantics

- Branch definitions include branch condition and the branch-judge node used for evaluation.
- Loop definitions include loop condition and the loop-judge node used for continuation/termination.
- `loops[]` is the explicit workflow-level loop policy container.
- Workflow must represent both as explicit graph/control-flow elements.
- Branch matching behavior uses fan-out: all matching outbound branches are executed.

## Sub-Workflow Semantics

- Node sequences can be grouped and defined as `subWorkflows`.
- Each `subWorkflow` must define:
  - `managerNodeId` (node kind `sub-manager`; the sub-workflow-local `sub oyakata`)
  - `inputNodeId` (node kind `input`)
  - `outputNodeId` (node kind `output`)
  - `nodeIds` (complete membership list of node ids owned by that sub-workflow; must include `managerNodeId`, `inputNodeId`, and `outputNodeId`)
- `inputSources` may reference:
  - human input (`type: "human-input"`)
  - another workflow output (`type: "workflow-output"`)
  - another node output (`type: "node-output"`, with `nodeId`)
  - another sub-workflow output (`type: "sub-workflow-output"`, with `subWorkflowId`)
- output-based sources must declare `selectionPolicy` when multiple executions are possible:
  - `explicit` (with `nodeExecId`)
  - `latest-succeeded`
  - `latest-any`
  - `by-loop-iteration` (with `loopIteration`)
- root `managerNodeId` is required and must point to a node with kind `root-manager`.
- each `subWorkflow.managerNodeId` is required and must point to a node with kind `sub-manager`.
- each `subWorkflow.nodeIds` is required and must fully define membership for mailbox write-boundary validation.
- Parent-workflow or peer-sub-workflow deliveries must target the recipient sub-workflow `managerNodeId`.
- The recipient sub-workflow manager orchestrates sub-workflow execution, reads that delivery, and instructs child nodes inside the sub-workflow.

## Inter-Sub-Workflow Conversation Semantics

- `subWorkflowConversations` defines managed dialog sessions between sub-workflows.
- Each conversation must define:
  - `id`
  - `participants` (array of sub-workflow ids)
  - `maxTurns`
  - `stopWhen` (termination expression)
- `conversationPolicy` may define advanced orchestration:
  - `turnPolicy`: speaker selection strategy (`round-robin`, `judge-priority`, `score-priority`)
  - `memoryPolicy`: role context policy (`shared`, `role-local`, `hybrid`) and history window
  - `toolPolicy`: per-role allowed tools/capabilities
  - `convergencePolicy`: scoring thresholds and completion rules
  - `parallelBranches`: optional branch fan-out and merge policy (`all`, `majority`, `judge`)
  - `budgetPolicy`: token/cost ceilings and hard-stop behavior
- The manager node routes all messages between participants.
- Conversation transcript is persisted in session runtime state and available as an input source for participating sub-workflows.
- Routed conversation messages must carry an `OutputRef` that points to a concrete execution artifact (`output.json`) for deterministic replay and auditing.
- Runtime transport for those routed messages is the node mailbox defined in `design-docs/specs/design-node-mailbox.md`; conversation transcript records are orchestration views over mailbox-backed deliveries, not a second transport channel.

`OutputRef` conceptual shape:

```json
{
  "workflowExecutionId": "wfexec-20260223-001",
  "workflowId": "impl-hardening-loop",
  "subWorkflowId": "subgroup2-security",
  "outputNodeId": "sg2-output",
  "nodeExecId": "nodeexec-00017",
  "artifactDir": "{artifact-root}/impl-hardening-loop/executions/wfexec-20260223-001/nodes/sg2-output/nodeexec-00017"
}
```

## Node Input Injection and Template Policy

Node execution supports two complementary payloads:
- `promptText`: rendered from `promptTemplate` + `variables`
- `arguments`: structured object assembled from `argumentsTemplate` + `argumentBindings`

Required policy:
- For adapters that accept `ARGUMENTS` only (for example Codex/Claude skill-like handlers), pass the assembled `arguments` object.
- Use simple text templating (`mustache`) for prompt rendering.
- Do not rely on complex template logic (full Handlebars helpers/control flow) for core data assembly.
- Use explicit `argumentBindings` from artifact outputs and workflow state to maintain deterministic behavior.

## Canonical Case 1: Implementation/Review Loop

This section defines a concrete workflow pattern matching the following intent:

`oyakata` -> user implementation instruction -> implementation -> subgroup1 -> subgroup2 -> subgroup3 -> subgroup4, then loop (max 3 rounds).

Subgroup structure:
- `subgroup1`: anti-pattern review and implementation correction cycle
  - review1 (anti-pattern review)
  - counter-opinion based on review1
  - mediation between review1 and counter-opinion
  - implementation fix
  - commit execution
- `subgroup2`: security review and correction cycle
  - security review
  - rebuttal to security review
  - mediation
  - implementation fix based on mediated decision
- `subgroup3`: review whether tests are legitimate (not improper/fake)
- `subgroup4`: end-of-round consolidation and loop-judge handoff

Conceptual `workflow.json` fragment:

```json
{
  "workflowId": "impl-hardening-loop",
  "description": "Iterative implementation with anti-pattern, security, and test-integrity gates.",
  "defaults": {
    "maxLoopIterations": 3,
    "nodeTimeoutMs": 120000
  },
  "managerNodeId": "oyakata-manager",
  "subWorkflows": [
    {
      "id": "subgroup1-antipattern",
      "description": "Anti-pattern review, counter-opinion, mediation, fix, commit.",
      "managerNodeId": "sg1-sub-oyakata",
      "inputNodeId": "sg1-input",
      "outputNodeId": "sg1-output",
      "nodeIds": ["sg1-sub-oyakata", "sg1-input", "sg1-output"],
      "inputSources": [
        { "type": "node-output", "nodeId": "implementation-node" }
      ]
    },
    {
      "id": "subgroup2-security",
      "description": "Security review, rebuttal, mediation, fix.",
      "managerNodeId": "sg2-sub-oyakata",
      "inputNodeId": "sg2-input",
      "outputNodeId": "sg2-output",
      "nodeIds": ["sg2-sub-oyakata", "sg2-input", "sg2-output"],
      "inputSources": [
        { "type": "sub-workflow-output", "subWorkflowId": "subgroup1-antipattern" }
      ]
    },
    {
      "id": "subgroup3-test-integrity",
      "description": "Validate tests are legitimate and not improper.",
      "managerNodeId": "sg3-sub-oyakata",
      "inputNodeId": "sg3-input",
      "outputNodeId": "sg3-output",
      "nodeIds": ["sg3-sub-oyakata", "sg3-input", "sg3-output"],
      "inputSources": [
        { "type": "sub-workflow-output", "subWorkflowId": "subgroup2-security" }
      ]
    },
    {
      "id": "subgroup4-round-close",
      "description": "Finalize round and prepare loop-judge decision.",
      "managerNodeId": "sg4-sub-oyakata",
      "inputNodeId": "sg4-input",
      "outputNodeId": "sg4-output",
      "nodeIds": ["sg4-sub-oyakata", "sg4-input", "sg4-output"],
      "inputSources": [
        { "type": "sub-workflow-output", "subWorkflowId": "subgroup3-test-integrity" }
      ]
    }
  ],
  "subWorkflowConversations": [
    {
      "id": "sg1-sg2-alignment-dialog",
      "participants": ["subgroup1-antipattern", "subgroup2-security"],
      "maxTurns": 4,
      "stopWhen": "mediation_complete"
    },
    {
      "id": "sg2-sg3-quality-dialog",
      "participants": ["subgroup2-security", "subgroup3-test-integrity"],
      "maxTurns": 4,
      "stopWhen": "mediation_complete"
    }
  ],
  "edges": [
    { "from": "oyakata-manager", "to": "user-implementation-instruction", "when": "always" },
    { "from": "user-implementation-instruction", "to": "implementation-node", "when": "always" },
    { "from": "implementation-node", "to": "subgroup1-antipattern", "when": "always" },
    { "from": "subgroup1-antipattern", "to": "subgroup2-security", "when": "always" },
    { "from": "subgroup2-security", "to": "subgroup3-test-integrity", "when": "always" },
    { "from": "subgroup3-test-integrity", "to": "subgroup4-round-close", "when": "always" },
    { "from": "subgroup4-round-close", "to": "loop-judge-round", "when": "always" },
    { "from": "loop-judge-round", "to": "implementation-node", "when": "continue_round" },
    { "from": "loop-judge-round", "to": "done", "when": "rounds_complete" }
  ],
  "loops": [
    {
      "id": "implementation-hardening-loop",
      "judgeNodeId": "loop-judge-round",
      "maxIterations": 3,
      "continueWhen": "continue_round",
      "exitWhen": "rounds_complete"
    }
  ]
}
```

## Canonical Case 2: Adversarial Debate and Improvement Loop

This section defines an automated debate workflow where multiple role nodes repeatedly propose attacks/defenses and improve the implementation.

Base security pattern:
- `oyakata`
- user instruction
- blackhat attempt (round start)
- commit
- whitehat defense proposal from blackhat result
- commit
- blackhat re-penetration based on whitehat output
- commit
- whitehat hardening update
- mediation node decides:
  - finish when major issues are exhausted, or
  - continue until max rounds are reached

Conceptual `workflow.json` fragment:

```json
{
  "workflowId": "security-adversarial-loop",
  "description": "Blackhat/whitehat debate loop with mediation-driven completion.",
  "defaults": {
    "maxLoopIterations": 6,
    "nodeTimeoutMs": 120000
  },
  "managerNodeId": "oyakata-manager",
  "subWorkflows": [
    {
      "id": "blackhat-sw",
      "description": "Attempt penetration based on latest code state and prior defenses.",
      "managerNodeId": "blackhat-sub-oyakata",
      "inputNodeId": "blackhat-input",
      "outputNodeId": "blackhat-output",
      "nodeIds": ["blackhat-sub-oyakata", "blackhat-input", "blackhat-output"],
      "inputSources": [
        { "type": "node-output", "nodeId": "user-implementation-instruction" },
        { "type": "sub-workflow-output", "subWorkflowId": "whitehat-sw" }
      ]
    },
    {
      "id": "whitehat-sw",
      "description": "Design and apply defenses for discovered vulnerabilities.",
      "managerNodeId": "whitehat-sub-oyakata",
      "inputNodeId": "whitehat-input",
      "outputNodeId": "whitehat-output",
      "nodeIds": ["whitehat-sub-oyakata", "whitehat-input", "whitehat-output"],
      "inputSources": [
        { "type": "sub-workflow-output", "subWorkflowId": "blackhat-sw" }
      ]
    },
    {
      "id": "mediation-sw",
      "description": "Judge coverage and decide continue/finish.",
      "managerNodeId": "mediation-sub-oyakata",
      "inputNodeId": "mediation-input",
      "outputNodeId": "mediation-output",
      "nodeIds": ["mediation-sub-oyakata", "mediation-input", "mediation-output"],
      "inputSources": [
        { "type": "sub-workflow-output", "subWorkflowId": "blackhat-sw" },
        { "type": "sub-workflow-output", "subWorkflowId": "whitehat-sw" }
      ]
    }
  ],
  "subWorkflowConversations": [
    {
      "id": "blackhat-whitehat-dialog",
      "participants": ["blackhat-sw", "whitehat-sw"],
      "maxTurns": 8,
      "stopWhen": "mediation_ready"
    },
    {
      "id": "security-triage-dialog",
      "participants": ["blackhat-sw", "mediation-sw"],
      "maxTurns": 4,
      "stopWhen": "triage_complete"
    }
  ],
  "edges": [
    { "from": "oyakata-manager", "to": "user-implementation-instruction", "when": "always" },
    { "from": "user-implementation-instruction", "to": "blackhat-sw", "when": "always" },
    { "from": "blackhat-sw", "to": "commit-after-blackhat", "when": "always" },
    { "from": "commit-after-blackhat", "to": "whitehat-sw", "when": "always" },
    { "from": "whitehat-sw", "to": "commit-after-whitehat", "when": "always" },
    { "from": "commit-after-whitehat", "to": "blackhat-sw", "when": "re-penetration" },
    { "from": "commit-after-whitehat", "to": "mediation-sw", "when": "ready-for-mediation" },
    { "from": "mediation-sw", "to": "loop-judge-security", "when": "always" },
    { "from": "loop-judge-security", "to": "blackhat-sw", "when": "continue_round" },
    { "from": "loop-judge-security", "to": "done", "when": "issues_exhausted || max_rounds_reached" }
  ],
  "loops": [
    {
      "id": "security-adversarial-loop",
      "judgeNodeId": "loop-judge-security",
      "maxIterations": 6,
      "continueWhen": "continue_round",
      "exitWhen": "issues_exhausted || max_rounds_reached"
    }
  ]
}
```

Generalization rule:
- The same debate-loop structure is reusable beyond security.
- Example domains:
  - web app design improvement
  - feature quality improvement
- Reuse by changing role semantics (for example: challenger/defender/mediator) while preserving:
  - role-to-role conversation
  - commit checkpoints
  - loop-judge termination (`quality_saturated || max_rounds_reached`)

## Loop Semantics

Looping is represented by edges that target an upstream node.

Loop controls:
- `maxIterations` per loop path (optional if global default exists)
- optional backoff policy
- fallback edge when loop budget is exhausted

If loop-specific limits are omitted, `workflow.json.defaults.maxLoopIterations` is applied.

## Completion Semantics

Completion block determines whether node execution is accepted.

Supported conceptual strategies:
- `checklist`
- `score-threshold`
- `validator-result`
- `none` (no success judgment; node is treated as auto-complete after successful execution)

Completion result drives transition decisions.

## Timeout Semantics

- Each node may define `timeoutMs` in `node-{id}.json`.
- If omitted, `workflow.json.defaults.nodeTimeoutMs` is used.
- Timeout expiration should produce a timeout-specific failure result for routing/handling.

## Validation Rules (Conceptual)

- Workflow must be located under `<workflow-root>/<workflow-name>/`.
- `workflow.json` must include `description`.
- Node ids must be unique and match `^[a-z0-9][a-z0-9-]{1,63}$`.
- All edge endpoints must exist.
- Every executable node must have a valid `node-{id}.json`.
- Every node execution must persist artifacts under `{artifact-root}/{workflow_id}/executions/{workflowExecutionId}/nodes/{node}/{node-exec-id}/`.
- Every execution artifact directory must contain `input.json`, `output.json`, and `meta.json`.
- `managerNodeId` must be present and point to a node with `kind: "root-manager"`.
- Every `subWorkflow` must include one `sub-manager`, one `input`, and one `output` node reference.
- Every `subWorkflow` must include `nodeIds`, and those node ids must be unique across sub-workflows.
- Cross-sub-workflow deliveries must target the recipient `subWorkflow.managerNodeId`, not a leaf task node.
- Every `subWorkflow.inputSources[]` entry must use one of:
  - `human-input`
  - `workflow-output`
  - `node-output`
  - `sub-workflow-output`
- Every `subWorkflowConversations[].participants[]` entry must reference an existing `subWorkflow.id`.
- `subWorkflowConversations[].participants` must contain at least two distinct sub-workflow ids.
- `subWorkflowConversations[].maxTurns` must be a positive integer.
- If `conversationPolicy.turnPolicy = "score-priority"`, `convergencePolicy` must define scoring fields.
- If `conversationPolicy.parallelBranches` is set, merge policy must be one of `all`, `majority`, `judge`.
- If `conversationPolicy.budgetPolicy` is set, token/cost limits must be positive numbers.
- Loop patterns like subgroup1->subgroup2->subgroup3->subgroup4 must be bounded by `loops[].maxIterations` or workflow default.
- Adversarial debate loops (e.g. blackhat/whitehat/mediator) must define explicit termination via issue exhaustion and/or max rounds.
- `workflow-vis.json` must be treated as visualization state only.
- Looping paths must be bounded by loop-local limits or global default.
- Completion block may be omitted when node is configured as auto-complete or `completion.type = "none"`.

## References

- `design-docs/specs/architecture.md`
- `design-docs/specs/command.md`
- `design-docs/specs/design-data-model.md`
