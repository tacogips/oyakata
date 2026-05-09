import { normalizeWorkflowRelativeJsonPath } from "./authored-node";
import {
  NODE_ID_PATTERN,
  type NodeKind,
  type ValidationIssue,
  type WorkflowNodeExecutionPolicy,
  type WorkflowNodeRegistryRef,
  type WorkflowNodeRepeatPolicy,
  type WorkflowStepRef,
  type WorkflowStepSessionPolicy,
  type WorkflowStepTransition,
  type WorkflowTimeoutPolicy,
} from "./types";
import {
  isNodeSessionMode,
  isRecord,
  makeIssue,
  normalizeNodeRole,
  normalizeWorkflowNodeAddonRef,
  readStringField,
  type WorkflowValidationOptions,
} from "./validate-helpers";

export function normalizeWorkflowTimeoutPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WorkflowTimeoutPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const onTimeout = value["onTimeout"];
  if (
    onTimeout !== "fail" &&
    onTimeout !== "retry-same-step" &&
    onTimeout !== "jump-to-step"
  ) {
    issues.push(
      makeIssue(
        "error",
        `${path}.onTimeout`,
        "must be 'fail', 'retry-same-step', or 'jump-to-step'",
      ),
    );
    return undefined;
  }

  const maxRetriesRaw = value["maxRetries"];
  let maxRetries: number | undefined;
  if (maxRetriesRaw !== undefined) {
    if (
      typeof maxRetriesRaw === "number" &&
      Number.isInteger(maxRetriesRaw) &&
      maxRetriesRaw >= 0
    ) {
      maxRetries = maxRetriesRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.maxRetries`,
          "must be an integer >= 0 when provided",
        ),
      );
    }
  }

  const retryTimeoutIncrementMsRaw = value["retryTimeoutIncrementMs"];
  let retryTimeoutIncrementMs: number | undefined;
  if (retryTimeoutIncrementMsRaw !== undefined) {
    if (
      typeof retryTimeoutIncrementMsRaw === "number" &&
      Number.isFinite(retryTimeoutIncrementMsRaw) &&
      retryTimeoutIncrementMsRaw >= 0
    ) {
      retryTimeoutIncrementMs = retryTimeoutIncrementMsRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.retryTimeoutIncrementMs`,
          "must be >= 0 when provided",
        ),
      );
    }
  }

  const jumpStepIdRaw = value["jumpStepId"];
  let jumpStepId: string | undefined;
  if (jumpStepIdRaw !== undefined) {
    if (typeof jumpStepIdRaw === "string" && jumpStepIdRaw.length > 0) {
      jumpStepId = jumpStepIdRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.jumpStepId`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const reuseBackendSessionRaw = value["reuseBackendSession"];
  let reuseBackendSession: boolean | undefined;
  if (reuseBackendSessionRaw !== undefined) {
    if (typeof reuseBackendSessionRaw === "boolean") {
      reuseBackendSession = reuseBackendSessionRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.reuseBackendSession`,
          "must be a boolean when provided",
        ),
      );
    }
  }

  if (onTimeout === "jump-to-step" && jumpStepId === undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.jumpStepId`,
        "is required when onTimeout is 'jump-to-step'",
      ),
    );
  }

  return {
    onTimeout,
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(retryTimeoutIncrementMs === undefined
      ? {}
      : { retryTimeoutIncrementMs }),
    ...(jumpStepId === undefined ? {} : { jumpStepId }),
    ...(reuseBackendSession === undefined ? {} : { reuseBackendSession }),
  };
}

export const NODE_KIND_VALUES = new Set<NodeKind>([
  "task",
  "branch-judge",
  "loop-judge",
  "input",
  "output",
]);

export function normalizeRegistryNodeKind(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): NodeKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !NODE_KIND_VALUES.has(value as NodeKind)) {
    issues.push(
      makeIssue(
        "error",
        path,
        "must be 'task', 'branch-judge', 'loop-judge', 'input', or 'output'",
      ),
    );
    return undefined;
  }
  return value as NodeKind;
}

export function normalizeWorkflowNodeRepeatPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WorkflowNodeRepeatPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return undefined;
  }
  const whileRaw = value["while"];
  if (typeof whileRaw !== "string" || whileRaw.length === 0) {
    issues.push(
      makeIssue("error", `${path}.while`, "must be a non-empty string"),
    );
    return undefined;
  }
  const restartAtRaw = value["restartAt"];
  const maxIterationsRaw = value["maxIterations"];
  let restartAt: string | undefined;
  if (restartAtRaw !== undefined) {
    if (typeof restartAtRaw !== "string" || restartAtRaw.length === 0) {
      issues.push(
        makeIssue("error", `${path}.restartAt`, "must be a non-empty string"),
      );
    } else {
      restartAt = restartAtRaw;
    }
  }
  let maxIterations: number | undefined;
  if (maxIterationsRaw !== undefined) {
    if (
      typeof maxIterationsRaw !== "number" ||
      !Number.isInteger(maxIterationsRaw) ||
      maxIterationsRaw < 1
    ) {
      issues.push(
        makeIssue(
          "error",
          `${path}.maxIterations`,
          "must be a positive integer when provided",
        ),
      );
    } else {
      maxIterations = maxIterationsRaw;
    }
  }
  return {
    while: whileRaw,
    ...(restartAt === undefined ? {} : { restartAt }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
  };
}

export function normalizeWorkflowNodeRegistryRef(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): WorkflowNodeRegistryRef | null {
  const path = `workflow.nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const allowedKeys = new Set([
    "id",
    "nodeFile",
    "addon",
    "execution",
    "kind",
    "repeat",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported step-addressed node registry field",
        ),
      );
    }
  }

  const id = readStringField(value, "id", path, issues);
  if (id !== null && !NODE_ID_PATTERN.test(id)) {
    issues.push(
      makeIssue("error", `${path}.id`, "must match ^[a-z0-9][a-z0-9-]{1,63}$"),
    );
  }

  const nodeFileRaw = value["nodeFile"];
  let nodeFile: string | undefined;
  if (nodeFileRaw !== undefined) {
    if (typeof nodeFileRaw !== "string" || nodeFileRaw.length === 0) {
      issues.push(
        makeIssue("error", `${path}.nodeFile`, "must be a non-empty string"),
      );
    } else {
      nodeFile = normalizeWorkflowRelativeJsonPath(nodeFileRaw);
    }
  }

  const addon = normalizeWorkflowNodeAddonRef(
    value["addon"],
    `${path}.addon`,
    issues,
  );
  const execution = normalizeWorkflowNodeExecutionPolicy(
    value["execution"],
    `${path}.execution`,
    issues,
  );
  const kind = normalizeRegistryNodeKind(value["kind"], `${path}.kind`, issues);
  const repeat = normalizeWorkflowNodeRepeatPolicy(
    value["repeat"],
    `${path}.repeat`,
    issues,
  );

  if ((nodeFile === undefined) === (addon === undefined)) {
    issues.push(
      makeIssue("error", path, "must declare exactly one of nodeFile or addon"),
    );
  }

  if (id === null) {
    return null;
  }

  return {
    id,
    ...(nodeFile === undefined ? {} : { nodeFile }),
    ...(addon === undefined ? {} : { addon }),
    ...(execution === undefined ? {} : { execution }),
    ...(kind === undefined ? {} : { kind }),
    ...(repeat === undefined ? {} : { repeat }),
  };
}

export function normalizeWorkflowStepTransition(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WorkflowStepTransition | null {
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const allowedKeys = new Set([
    "toStepId",
    "toWorkflowId",
    "resumeStepId",
    "label",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported step transition field",
        ),
      );
    }
  }

  const toStepId = readStringField(value, "toStepId", path, issues);
  const toWorkflowIdRaw = value["toWorkflowId"];
  let toWorkflowId: string | undefined;
  if (toWorkflowIdRaw !== undefined) {
    if (typeof toWorkflowIdRaw === "string" && toWorkflowIdRaw.length > 0) {
      toWorkflowId = toWorkflowIdRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.toWorkflowId`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const resumeStepIdRaw = value["resumeStepId"];
  let resumeStepId: string | undefined;
  if (resumeStepIdRaw !== undefined) {
    if (typeof resumeStepIdRaw === "string" && resumeStepIdRaw.length > 0) {
      resumeStepId = resumeStepIdRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.resumeStepId`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const labelRaw = value["label"];
  let label: string | undefined;
  if (labelRaw !== undefined) {
    if (typeof labelRaw === "string" && labelRaw.length > 0) {
      label = labelRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.label`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  if (toWorkflowId === undefined && resumeStepId !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.resumeStepId`,
        "is supported only when toWorkflowId is set",
      ),
    );
  }

  if (toStepId === null) {
    return null;
  }

  return {
    toStepId,
    ...(toWorkflowId === undefined ? {} : { toWorkflowId }),
    ...(resumeStepId === undefined ? {} : { resumeStepId }),
    ...(label === undefined ? {} : { label }),
  };
}

export function normalizeWorkflowStepSessionPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WorkflowStepSessionPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const allowedKeys = new Set(["mode", "inheritFromStepId"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported step session policy field",
        ),
      );
    }
  }

  const modeRaw = value["mode"];
  let mode: WorkflowStepSessionPolicy["mode"];
  if (modeRaw !== undefined) {
    if (isNodeSessionMode(modeRaw)) {
      mode = modeRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.mode`,
          "must be 'new' or 'reuse' when provided",
        ),
      );
    }
  }

  const inheritFromStepIdRaw = value["inheritFromStepId"];
  let inheritFromStepId: string | undefined;
  if (inheritFromStepIdRaw !== undefined) {
    if (
      typeof inheritFromStepIdRaw === "string" &&
      inheritFromStepIdRaw.length > 0
    ) {
      inheritFromStepId = inheritFromStepIdRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.inheritFromStepId`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(inheritFromStepId === undefined ? {} : { inheritFromStepId }),
  };
}

export function normalizeWorkflowNodeExecutionPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WorkflowNodeExecutionPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return undefined;
  }

  const allowedKeys = new Set(["mode", "decisionBy"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported workflow node execution field",
        ),
      );
    }
  }

  const modeRaw = value["mode"];
  let mode: WorkflowNodeExecutionPolicy["mode"] | undefined;
  if (modeRaw !== undefined) {
    if (modeRaw === "required" || modeRaw === "optional") {
      mode = modeRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.mode`,
          "must be 'required' or 'optional' when provided",
        ),
      );
    }
  }

  const decisionByRaw = value["decisionBy"];
  let decisionBy: WorkflowNodeExecutionPolicy["decisionBy"] | undefined;
  if (decisionByRaw !== undefined) {
    if (decisionByRaw === "owning-manager") {
      decisionBy = decisionByRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.decisionBy`,
          "must be 'owning-manager' when provided",
        ),
      );
    }
  }

  return {
    ...(mode === undefined ? {} : { mode }),
    ...(decisionBy === undefined ? {} : { decisionBy }),
  };
}

export function normalizeWorkflowStepRef(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
  options: Pick<WorkflowValidationOptions, "allowResolvedStepFileFields">,
): WorkflowStepRef | null {
  const path = `workflow.steps[${index}]`;
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const allowedKeys = new Set([
    "id",
    "stepFile",
    "nodeId",
    "description",
    "role",
    "promptVariant",
    "timeoutMs",
    "sessionPolicy",
    "transitions",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue("error", `${path}.${key}`, "uses an unsupported step field"),
      );
    }
  }

  const id = readStringField(value, "id", path, issues);
  const stepFileRaw = value["stepFile"];
  let stepFile: string | undefined;
  if (stepFileRaw !== undefined) {
    if (typeof stepFileRaw === "string" && stepFileRaw.length > 0) {
      stepFile = normalizeWorkflowRelativeJsonPath(stepFileRaw);
    } else {
      issues.push(
        makeIssue("error", `${path}.stepFile`, "must be a non-empty string"),
      );
    }
  }
  if (stepFile !== undefined && options.allowResolvedStepFileFields !== true) {
    for (const inlineField of [
      "nodeId",
      "description",
      "role",
      "promptVariant",
      "timeoutMs",
      "sessionPolicy",
      "transitions",
    ] as const) {
      if (value[inlineField] !== undefined) {
        issues.push(
          makeIssue(
            "error",
            `${path}.${inlineField}`,
            "must not be authored inline when workflow.steps[].stepFile is used",
          ),
        );
      }
    }
  }

  const nodeIdRaw = value["nodeId"];
  let nodeId: string | undefined;
  if (typeof nodeIdRaw === "string" && nodeIdRaw.length > 0) {
    nodeId = nodeIdRaw;
  } else {
    issues.push(
      makeIssue(
        "error",
        `${path}.nodeId`,
        "must be a non-empty string after step files are resolved",
      ),
    );
  }

  const descriptionRaw = value["description"];
  let description: string | undefined;
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw === "string" && descriptionRaw.length > 0) {
      description = descriptionRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.description`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const role = normalizeNodeRole(value["role"]);
  if (value["role"] !== undefined && role === undefined) {
    issues.push(
      makeIssue("error", `${path}.role`, "must be 'manager' or 'worker'"),
    );
  }

  const promptVariantRaw = value["promptVariant"];
  let promptVariant: string | undefined;
  if (promptVariantRaw !== undefined) {
    if (typeof promptVariantRaw === "string" && promptVariantRaw.length > 0) {
      promptVariant = promptVariantRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.promptVariant`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const timeoutMsRaw = value["timeoutMs"];
  let timeoutMs: number | undefined;
  if (timeoutMsRaw !== undefined) {
    if (
      typeof timeoutMsRaw === "number" &&
      Number.isFinite(timeoutMsRaw) &&
      timeoutMsRaw > 0
    ) {
      timeoutMs = timeoutMsRaw;
    } else {
      issues.push(
        makeIssue("error", `${path}.timeoutMs`, "must be > 0 when provided"),
      );
    }
  }

  const sessionPolicy = normalizeWorkflowStepSessionPolicy(
    value["sessionPolicy"],
    `${path}.sessionPolicy`,
    issues,
  );

  const transitionsRaw = value["transitions"];
  let transitions: readonly WorkflowStepTransition[] | undefined;
  if (transitionsRaw !== undefined) {
    if (!Array.isArray(transitionsRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.transitions`,
          "must be an array when provided",
        ),
      );
    } else {
      transitions = transitionsRaw
        .map((transition, transitionIndex) =>
          normalizeWorkflowStepTransition(
            transition,
            `${path}.transitions[${transitionIndex}]`,
            issues,
          ),
        )
        .filter(
          (transition): transition is WorkflowStepTransition =>
            transition !== null,
        );
    }
  }

  if (id === null || nodeId === undefined) {
    return null;
  }

  return {
    id,
    ...(stepFile === undefined ? {} : { stepFile }),
    nodeId,
    ...(description === undefined ? {} : { description }),
    ...(role === undefined ? {} : { role }),
    ...(promptVariant === undefined ? {} : { promptVariant }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
    ...(transitions === undefined ? {} : { transitions }),
  };
}
