import { collectStepAddressedAuthoredWorkflowFieldIssues } from "./authored-workflow";
import { synthesizeInlineNodeFile } from "./authored-node";
import { isSafeWorkflowId } from "./paths";
import {
  DEFAULT_MAX_LOOP_ITERATIONS,
  type ValidationIssue,
  type WorkflowJson,
  type WorkflowNodeRef,
  type WorkflowNodeRegistryRef,
  type WorkflowPrompts,
  type WorkflowStepRef,
} from "./types";
import {
  isRecord,
  makeIssue,
  normalizeContainerRuntimeDefaults,
  readNumberField,
  readStringField,
  type UnknownRecord,
  type WorkflowValidationOptions,
} from "./validate-helpers";
import {
  normalizeWorkflowNodeRegistryRef,
  normalizeWorkflowStepRef,
  normalizeWorkflowTimeoutPolicy,
} from "./validate-policy";

export function normalizeStepAddressedWorkflow(
  workflow: UnknownRecord,
  issues: ValidationIssue[],
  options: WorkflowValidationOptions,
): WorkflowJson | null {
  const workflowId = readStringField(
    workflow,
    "workflowId",
    "workflow",
    issues,
  );
  if (workflowId !== null && !isSafeWorkflowId(workflowId)) {
    issues.push(
      makeIssue(
        "error",
        "workflow.workflowId",
        "must start with an alphanumeric character and contain only letters, digits, hyphens, or underscores",
      ),
    );
  }

  const descriptionRaw = workflow["description"];
  let description = "";
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw === "string" && descriptionRaw.length > 0) {
      description = descriptionRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          "workflow.description",
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const defaultsValue = workflow["defaults"];
  if (!isRecord(defaultsValue)) {
    issues.push(makeIssue("error", "workflow.defaults", "must be an object"));
  }
  const nodeTimeoutMs =
    isRecord(defaultsValue) &&
    readNumberField(
      defaultsValue,
      "nodeTimeoutMs",
      "workflow.defaults",
      issues,
    );
  const maxLoopIterationsRaw =
    isRecord(defaultsValue) && defaultsValue["maxLoopIterations"] !== undefined
      ? readNumberField(
          defaultsValue,
          "maxLoopIterations",
          "workflow.defaults",
          issues,
        )
      : DEFAULT_MAX_LOOP_ITERATIONS;
  const containerRuntime = normalizeContainerRuntimeDefaults(
    isRecord(defaultsValue) ? defaultsValue["containerRuntime"] : undefined,
    "workflow.defaults.containerRuntime",
    issues,
  );
  const timeoutPolicy = normalizeWorkflowTimeoutPolicy(
    isRecord(defaultsValue) ? defaultsValue["timeoutPolicy"] : undefined,
    "workflow.defaults.timeoutPolicy",
    issues,
  );

  let prompts: WorkflowPrompts | undefined;
  const promptsRaw = workflow["prompts"];
  if (promptsRaw !== undefined) {
    if (!isRecord(promptsRaw)) {
      issues.push(
        makeIssue(
          "error",
          "workflow.prompts",
          "must be an object when provided",
        ),
      );
    } else {
      const divedraPromptTemplateRaw = promptsRaw["divedraPromptTemplate"];
      const workerSystemPromptTemplateRaw =
        promptsRaw["workerSystemPromptTemplate"];

      if (
        divedraPromptTemplateRaw !== undefined &&
        typeof divedraPromptTemplateRaw !== "string"
      ) {
        issues.push(
          makeIssue(
            "error",
            "workflow.prompts.divedraPromptTemplate",
            "must be a string when provided",
          ),
        );
      }
      if (
        workerSystemPromptTemplateRaw !== undefined &&
        typeof workerSystemPromptTemplateRaw !== "string"
      ) {
        issues.push(
          makeIssue(
            "error",
            "workflow.prompts.workerSystemPromptTemplate",
            "must be a string when provided",
          ),
        );
      }

      prompts = {
        ...(typeof divedraPromptTemplateRaw === "string"
          ? { divedraPromptTemplate: divedraPromptTemplateRaw }
          : {}),
        ...(typeof workerSystemPromptTemplateRaw === "string"
          ? { workerSystemPromptTemplate: workerSystemPromptTemplateRaw }
          : {}),
      };
    }
  }

  const entryStepId = readStringField(
    workflow,
    "entryStepId",
    "workflow",
    issues,
  );
  const managerStepIdRaw = workflow["managerStepId"];
  let managerStepId: string | undefined | null;
  if (managerStepIdRaw !== undefined) {
    if (typeof managerStepIdRaw === "string" && managerStepIdRaw.length > 0) {
      managerStepId = managerStepIdRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          "workflow.managerStepId",
          "must be a non-empty string when provided",
        ),
      );
      managerStepId = null;
    }
  }

  issues.push(...collectStepAddressedAuthoredWorkflowFieldIssues(workflow));

  const nodeRegistryRaw = workflow["nodes"];
  if (!Array.isArray(nodeRegistryRaw)) {
    issues.push(makeIssue("error", "workflow.nodes", "must be an array"));
  }
  const nodeRegistry = Array.isArray(nodeRegistryRaw)
    ? nodeRegistryRaw
        .map((entry, index) =>
          normalizeWorkflowNodeRegistryRef(entry, index, issues),
        )
        .filter((entry): entry is WorkflowNodeRegistryRef => entry !== null)
    : [];
  if (Array.isArray(nodeRegistryRaw) && nodeRegistry.length === 0) {
    issues.push(
      makeIssue(
        "error",
        "workflow.nodes",
        "must contain at least one workflow node registry entry",
      ),
    );
  }

  const stepsRaw = workflow["steps"];
  if (!Array.isArray(stepsRaw)) {
    issues.push(makeIssue("error", "workflow.steps", "must be an array"));
  }
  const steps = Array.isArray(stepsRaw)
    ? stepsRaw
        .map((entry, index) =>
          normalizeWorkflowStepRef(entry, index, issues, options),
        )
        .filter((entry): entry is WorkflowStepRef => entry !== null)
    : [];
  if (Array.isArray(stepsRaw) && steps.length === 0) {
    issues.push(
      makeIssue("error", "workflow.steps", "must contain at least one step"),
    );
  }

  const seenNodeRegistryIds = new Set<string>();
  nodeRegistry.forEach((node, index) => {
    if (seenNodeRegistryIds.has(node.id)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.nodes[${index}].id`,
          `duplicate node registry id '${node.id}'`,
        ),
      );
      return;
    }
    seenNodeRegistryIds.add(node.id);
  });

  const seenStepIds = new Set<string>();
  steps.forEach((step, index) => {
    if (seenStepIds.has(step.id)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.steps[${index}].id`,
          `duplicate step id '${step.id}'`,
        ),
      );
      return;
    }
    seenStepIds.add(step.id);
  });

  const stepIdSet = new Set(steps.map((step) => step.id));
  const explicitManagerSteps = steps.filter((step) => step.role === "manager");
  if (explicitManagerSteps.length > 1) {
    issues.push(
      makeIssue(
        "error",
        "workflow.steps",
        "must not declare more than one manager-role step",
      ),
    );
  }
  if (managerStepId === undefined && explicitManagerSteps.length === 1) {
    managerStepId = explicitManagerSteps[0]?.id;
  }
  if (managerStepId !== undefined && managerStepId !== null) {
    if (!stepIdSet.has(managerStepId)) {
      issues.push(
        makeIssue(
          "error",
          "workflow.managerStepId",
          `must reference an existing step id (${managerStepId})`,
        ),
      );
    }
    const explicitManagerStep = explicitManagerSteps[0];
    if (
      explicitManagerStep !== undefined &&
      explicitManagerStep.id !== managerStepId
    ) {
      issues.push(
        makeIssue(
          "error",
          "workflow.managerStepId",
          `must match the authored manager-role step '${explicitManagerStep.id}'`,
        ),
      );
    }
  }
  if (entryStepId !== null && !stepIdSet.has(entryStepId)) {
    issues.push(
      makeIssue(
        "error",
        "workflow.entryStepId",
        `must reference an existing step id (${entryStepId})`,
      ),
    );
  }

  steps.forEach((step, index) => {
    const registryNode = nodeRegistry.find((node) => node.id === step.nodeId);
    if (registryNode === undefined) {
      issues.push(
        makeIssue(
          "error",
          `workflow.steps[${index}].nodeId`,
          `must reference an existing workflow node registry entry (${step.nodeId})`,
        ),
      );
    } else {
      const stepRole =
        step.role ?? (step.id === managerStepId ? "manager" : "worker");
      if (stepRole === "manager" && registryNode.addon !== undefined) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${index}].nodeId`,
            `manager step '${step.id}' must reference a file-backed node; add-on-backed node registry entry '${step.nodeId}' is worker-only`,
          ),
        );
      }
    }
    const crossWorkflowTransitions = (step.transitions ?? []).filter(
      (t) => t.toWorkflowId !== undefined,
    );
    if (crossWorkflowTransitions.length > 1) {
      issues.push(
        makeIssue(
          "error",
          `workflow.steps[${index}]`,
          "must have at most one cross-workflow transition (toWorkflowId)",
        ),
      );
    }
    step.transitions?.forEach((transition, transitionIndex) => {
      if (transition.toWorkflowId !== undefined) {
        if (transition.resumeStepId === undefined) {
          issues.push(
            makeIssue(
              "error",
              `workflow.steps[${index}].transitions[${transitionIndex}].resumeStepId`,
              "is required when toWorkflowId is set (parent step to resume after the callee workflow completes)",
            ),
          );
        } else if (!stepIdSet.has(transition.resumeStepId)) {
          issues.push(
            makeIssue(
              "error",
              `workflow.steps[${index}].transitions[${transitionIndex}].resumeStepId`,
              `must reference an existing step id (${transition.resumeStepId})`,
            ),
          );
        }
      }
      if (
        transition.toWorkflowId === undefined &&
        !stepIdSet.has(transition.toStepId)
      ) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${index}].transitions[${transitionIndex}].toStepId`,
            `must reference an existing step id (${transition.toStepId})`,
          ),
        );
      }
    });
    if (
      step.sessionPolicy?.inheritFromStepId !== undefined &&
      !stepIdSet.has(step.sessionPolicy.inheritFromStepId)
    ) {
      issues.push(
        makeIssue(
          "error",
          `workflow.steps[${index}].sessionPolicy.inheritFromStepId`,
          `must reference an existing step id (${step.sessionPolicy.inheritFromStepId})`,
        ),
      );
    }
  });

  if (
    workflowId === null ||
    entryStepId === null ||
    managerStepId === null ||
    typeof nodeTimeoutMs !== "number" ||
    typeof maxLoopIterationsRaw !== "number"
  ) {
    return null;
  }

  const nodesMaterializedFromSteps: WorkflowNodeRef[] = steps.map((step) => {
    const registryNode = nodeRegistry.find((node) => node.id === step.nodeId);
    const role =
      step.role ?? (step.id === managerStepId ? "manager" : "worker");
    return {
      id: step.id,
      nodeFile: registryNode?.nodeFile ?? synthesizeInlineNodeFile(step.id),
      ...(registryNode?.addon === undefined
        ? {}
        : { addon: registryNode.addon }),
      ...(registryNode?.execution === undefined
        ? {}
        : { execution: registryNode.execution }),
      ...(registryNode?.kind === undefined ? {} : { kind: registryNode.kind }),
      ...(registryNode?.repeat === undefined
        ? {}
        : { repeat: registryNode.repeat }),
      role,
    };
  });
  return {
    workflowId,
    description,
    defaults: {
      nodeTimeoutMs,
      maxLoopIterations: maxLoopIterationsRaw,
      ...(timeoutPolicy === undefined ? {} : { timeoutPolicy }),
      ...(containerRuntime === undefined ? {} : { containerRuntime }),
    },
    ...(prompts === undefined ? {} : { prompts }),
    hasManagerNode: managerStepId !== undefined,
    ...(managerStepId === undefined ? {} : { managerStepId }),
    entryStepId,
    nodeRegistry,
    steps,
    nodes: nodesMaterializedFromSteps,
  };
}

export function normalizeWorkflow(
  workflow: unknown,
  issues: ValidationIssue[],
  options: WorkflowValidationOptions,
): WorkflowJson | null {
  if (!isRecord(workflow)) {
    issues.push(makeIssue("error", "workflow", "must be an object"));
    return null;
  }
  return normalizeStepAddressedWorkflow(workflow, issues, options);
}
