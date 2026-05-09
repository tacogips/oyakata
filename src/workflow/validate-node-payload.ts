import {
  isReservedWorkflowDefinitionPath,
  isSafeWorkflowRelativePath,
} from "./prompt-template-file";
import {
  normalizeCliAgentBackend,
  normalizeNodeExecutionBackend,
} from "./backend";
import { validateJsonSchemaDefinition } from "./json-schema";
import type {
  ArgumentBinding,
  JsonObject,
  NodeExecutionBackend,
  NodeOutputContract,
  NodePayload,
  NodePromptVariant,
  NodeSessionPolicy,
  NodeType,
  UserActionNodeConfig,
  ValidationIssue,
} from "./types";
import {
  isLegacyCliModelIdentifier,
  isNodeSessionMode,
  isNodeType,
  isRecord,
  makeIssue,
  normalizeCommandExecution,
  normalizeContainerExecution,
  normalizeNodeDurability,
  normalizeNamedStringArrayField,
  normalizeOptionalNamedStringArrayField,
  normalizeOptionalBooleanField,
  normalizeWorkingDirectoryField,
  readStringField,
  requiresSeparatedModel,
  type UnknownRecord,
} from "./validate-helpers";

export function normalizeNodeTemplateFields(args: {
  readonly path: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly issues: ValidationIssue[];
  readonly templateField: string;
  readonly templateFileField: string;
}): {
  readonly template?: string;
  readonly templateFile?: string;
} {
  const templateRaw = args.payload[args.templateField];
  const templateFileRaw = args.payload[args.templateFileField];

  let template: string | undefined;
  let templateFile: string | undefined;

  if (templateFileRaw !== undefined) {
    if (typeof templateFileRaw === "string" && templateFileRaw.length > 0) {
      if (isSafeWorkflowRelativePath(templateFileRaw)) {
        if (isReservedWorkflowDefinitionPath(templateFileRaw)) {
          args.issues.push(
            makeIssue(
              "error",
              `${args.path}.${args.templateFileField}`,
              "must not target canonical workflow definition files such as workflow.json or node-*.json",
            ),
          );
        } else {
          templateFile = templateFileRaw;
        }
      } else {
        args.issues.push(
          makeIssue(
            "error",
            `${args.path}.${args.templateFileField}`,
            "must be a workflow-relative path without '.' or '..' segments",
          ),
        );
      }
    } else {
      args.issues.push(
        makeIssue(
          "error",
          `${args.path}.${args.templateFileField}`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  if (typeof templateRaw === "string" && templateRaw.length > 0) {
    template = templateRaw;
  } else if (templateRaw !== undefined && typeof templateRaw !== "string") {
    args.issues.push(
      makeIssue(
        "error",
        `${args.path}.${args.templateField}`,
        "must be a non-empty string when provided",
      ),
    );
  } else if (typeof templateRaw === "string" && templateRaw.length === 0) {
    args.issues.push(
      makeIssue(
        "error",
        `${args.path}.${args.templateField}`,
        "must be a non-empty string when provided",
      ),
    );
  }

  return {
    ...(template === undefined ? {} : { template }),
    ...(templateFile === undefined ? {} : { templateFile }),
  };
}

export function normalizeNodePromptVariants(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): Readonly<Record<string, NodePromptVariant>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const variants: Record<string, NodePromptVariant> = {};
  for (const [variantName, variantValue] of Object.entries(value)) {
    if (variantName.length === 0) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${variantName}`,
          "variant names must be non-empty strings",
        ),
      );
      continue;
    }
    if (!isRecord(variantValue)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${variantName}`,
          "must be an object when provided",
        ),
      );
      continue;
    }
    const normalizedSystemPromptTemplate = normalizeNodeTemplateFields({
      path: `${path}.${variantName}`,
      payload: variantValue,
      issues,
      templateField: "systemPromptTemplate",
      templateFileField: "systemPromptTemplateFile",
    });
    const normalizedPromptTemplate = normalizeNodeTemplateFields({
      path: `${path}.${variantName}`,
      payload: variantValue,
      issues,
      templateField: "promptTemplate",
      templateFileField: "promptTemplateFile",
    });
    const normalizedSessionStartPromptTemplate = normalizeNodeTemplateFields({
      path: `${path}.${variantName}`,
      payload: variantValue,
      issues,
      templateField: "sessionStartPromptTemplate",
      templateFileField: "sessionStartPromptTemplateFile",
    });

    variants[variantName] = {
      ...(normalizedSystemPromptTemplate.template === undefined
        ? {}
        : {
            systemPromptTemplate: normalizedSystemPromptTemplate.template,
          }),
      ...(normalizedSystemPromptTemplate.templateFile === undefined
        ? {}
        : {
            systemPromptTemplateFile:
              normalizedSystemPromptTemplate.templateFile,
          }),
      ...(normalizedPromptTemplate.template === undefined
        ? {}
        : { promptTemplate: normalizedPromptTemplate.template }),
      ...(normalizedPromptTemplate.templateFile === undefined
        ? {}
        : { promptTemplateFile: normalizedPromptTemplate.templateFile }),
      ...(normalizedSessionStartPromptTemplate.template === undefined
        ? {}
        : {
            sessionStartPromptTemplate:
              normalizedSessionStartPromptTemplate.template,
          }),
      ...(normalizedSessionStartPromptTemplate.templateFile === undefined
        ? {}
        : {
            sessionStartPromptTemplateFile:
              normalizedSessionStartPromptTemplate.templateFile,
          }),
    };
  }

  return variants;
}

export function normalizeNodePayload(input: {
  readonly nodeId: string;
  readonly nodeFile: string;
  readonly payload: unknown;
  readonly issues: ValidationIssue[];
  readonly path?: string;
  readonly allowManagerCodePathDefaults?: boolean;
}): NodePayload | null {
  const path = input.path ?? `nodePayloads.${input.nodeFile}`;
  const payload = input.payload;
  const issues = input.issues;
  if (!isRecord(payload)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return null;
  }

  const id = readStringField(payload, "id", path, issues);
  if (id !== null && id !== input.nodeId) {
    issues.push(makeIssue("error", `${path}.id`, `must equal ${input.nodeId}`));
  }

  let nodeType: NodeType = "agent";
  const nodeTypeRaw = payload["nodeType"];
  if (nodeTypeRaw !== undefined) {
    if (nodeTypeRaw === "addon") {
      nodeType = "addon";
      issues.push(
        makeIssue(
          "error",
          `${path}.nodeType`,
          "nodeType 'addon' is runtime-owned; author add-ons with workflow.nodes[].addon",
        ),
      );
    } else if (isNodeType(nodeTypeRaw)) {
      nodeType = nodeTypeRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.nodeType`,
          "must be 'agent', 'command', 'container', or 'user-action'",
        ),
      );
    }
  }

  const command = normalizeCommandExecution(
    payload["command"],
    `${path}.command`,
    issues,
  );
  const container = normalizeContainerExecution(
    payload["container"],
    `${path}.container`,
    issues,
  );
  if (payload["runtimeIsolation"] !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.runtimeIsolation`,
        "legacy field 'runtimeIsolation' is not supported; use 'container'",
      ),
    );
  }
  if (container !== undefined && nodeTypeRaw === undefined) {
    nodeType = "container";
  }

  const managerTypeRaw = payload["managerType"];
  let managerType: NodePayload["managerType"];
  if (managerTypeRaw !== undefined) {
    if (managerTypeRaw === "code" || managerTypeRaw === "llm") {
      managerType = managerTypeRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.managerType`,
          "must be 'code' or 'llm' when provided",
        ),
      );
    }
  }
  const allowsManagerCodePathDefaults =
    input.allowManagerCodePathDefaults === true &&
    (managerType === undefined || managerType === "code");

  const modelRaw = payload["model"];
  let model: string | undefined;
  if (typeof modelRaw === "string" && modelRaw.length > 0) {
    model = modelRaw;
  } else if (
    modelRaw !== undefined &&
    nodeType === "agent" &&
    !allowsManagerCodePathDefaults
  ) {
    issues.push(
      makeIssue("error", `${path}.model`, "must be a non-empty string"),
    );
  } else if (modelRaw !== undefined && typeof modelRaw !== "string") {
    issues.push(
      makeIssue("error", `${path}.model`, "must be a non-empty string"),
    );
  }

  const executionBackendRaw = payload["executionBackend"];
  let executionBackend: NodeExecutionBackend | undefined;
  if (executionBackendRaw !== undefined) {
    const normalizedExecutionBackend =
      normalizeNodeExecutionBackend(executionBackendRaw);
    if (normalizedExecutionBackend !== null) {
      executionBackend = normalizedExecutionBackend;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.executionBackend`,
          "must be codex-agent, claude-code-agent, official/openai-sdk, or official/anthropic-sdk",
        ),
      );
    }
  } else if (nodeType === "agent" && !allowsManagerCodePathDefaults) {
    issues.push(
      makeIssue(
        "error",
        `${path}.executionBackend`,
        "is required for agent nodes",
      ),
    );
  }
  if (
    nodeType === "agent" &&
    model !== undefined &&
    requiresSeparatedModel(executionBackend) &&
    (normalizeCliAgentBackend(model) !== null ||
      isLegacyCliModelIdentifier(model))
  ) {
    issues.push(
      makeIssue(
        "error",
        `${path}.model`,
        `must be a provider or backend-specific model name when executionBackend is '${executionBackend}', not a tacogips CLI-wrapper identifier`,
      ),
    );
  }

  const normalizedSystemPromptTemplate = normalizeNodeTemplateFields({
    path,
    payload,
    issues,
    templateField: "systemPromptTemplate",
    templateFileField: "systemPromptTemplateFile",
  });
  const normalizedPromptTemplate = normalizeNodeTemplateFields({
    path,
    payload,
    issues,
    templateField: "promptTemplate",
    templateFileField: "promptTemplateFile",
  });
  const normalizedSessionStartPromptTemplate = normalizeNodeTemplateFields({
    path,
    payload,
    issues,
    templateField: "sessionStartPromptTemplate",
    templateFileField: "sessionStartPromptTemplateFile",
  });

  const promptTemplate = normalizedPromptTemplate.template;
  const promptTemplateFile = normalizedPromptTemplate.templateFile;
  const systemPromptTemplate = normalizedSystemPromptTemplate.template;
  const systemPromptTemplateFile = normalizedSystemPromptTemplate.templateFile;
  const sessionStartPromptTemplate =
    normalizedSessionStartPromptTemplate.template;
  const sessionStartPromptTemplateFile =
    normalizedSessionStartPromptTemplate.templateFile;
  const promptVariants = normalizeNodePromptVariants(
    payload["promptVariants"],
    `${path}.promptVariants`,
    issues,
  );
  if (
    promptTemplate === undefined &&
    nodeType === "agent" &&
    !allowsManagerCodePathDefaults
  ) {
    issues.push(
      makeIssue(
        "error",
        `${path}.promptTemplate`,
        "must be a non-empty string",
      ),
    );
  }

  const variablesRaw = payload["variables"];
  let variables: UnknownRecord | null = null;
  if (isRecord(variablesRaw)) {
    variables = variablesRaw;
  } else {
    issues.push(makeIssue("error", `${path}.variables`, "must be an object"));
  }
  if (payload["prompt"] !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.prompt`,
        "legacy field 'prompt' is not supported; use 'promptTemplate'",
      ),
    );
  }
  if (payload["variable"] !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.variable`,
        "legacy field 'variable' is not supported; use 'variables'",
      ),
    );
  }

  const descriptionRaw = payload["description"];
  const description =
    typeof descriptionRaw === "string" && descriptionRaw.trim().length > 0
      ? descriptionRaw
      : undefined;
  if (descriptionRaw !== undefined && typeof descriptionRaw !== "string") {
    issues.push(
      makeIssue(
        "error",
        `${path}.description`,
        "must be a non-empty string when provided",
      ),
    );
  } else if (typeof descriptionRaw === "string" && description === undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.description`,
        "must be a non-empty string when provided",
      ),
    );
  }

  const timeoutRaw = payload["timeoutMs"];
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw === "number" && timeoutRaw > 0) {
      timeoutMs = timeoutRaw;
    } else {
      issues.push(
        makeIssue("error", `${path}.timeoutMs`, "must be > 0 when provided"),
      );
    }
  }

  const durability = normalizeNodeDurability(
    payload["durability"],
    `${path}.durability`,
    issues,
  );
  const userAction = normalizeUserActionNodeConfig(
    payload["userAction"],
    `${path}.userAction`,
    issues,
  );

  const sessionPolicyRaw = payload["sessionPolicy"];
  let sessionPolicy: NodeSessionPolicy | undefined;
  if (sessionPolicyRaw !== undefined) {
    if (!isRecord(sessionPolicyRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.sessionPolicy`,
          "must be an object when provided",
        ),
      );
    } else if (!isNodeSessionMode(sessionPolicyRaw["mode"])) {
      issues.push(
        makeIssue(
          "error",
          `${path}.sessionPolicy.mode`,
          "must be 'new' or 'reuse'",
        ),
      );
    } else {
      sessionPolicy = { mode: sessionPolicyRaw["mode"] };
    }
  }

  const argumentsTemplateRaw = payload["argumentsTemplate"];
  let argumentsTemplate: UnknownRecord | undefined;
  if (argumentsTemplateRaw !== undefined) {
    if (isRecord(argumentsTemplateRaw)) {
      argumentsTemplate = argumentsTemplateRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.argumentsTemplate`,
          "must be an object when provided",
        ),
      );
    }
  }

  const argumentBindingsRaw = payload["argumentBindings"];
  let argumentBindings: readonly ArgumentBinding[] | undefined;
  if (argumentBindingsRaw !== undefined) {
    if (!Array.isArray(argumentBindingsRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.argumentBindings`,
          "must be an array when provided",
        ),
      );
    } else {
      const parsed: ArgumentBinding[] = [];
      argumentBindingsRaw.forEach((entry, index) => {
        const entryPath = `${path}.argumentBindings[${index}]`;
        if (!isRecord(entry)) {
          issues.push(makeIssue("error", entryPath, "must be an object"));
          return;
        }

        const targetPath = readStringField(
          entry,
          "targetPath",
          entryPath,
          issues,
        );
        const sourceRaw = entry["source"];
        if (
          sourceRaw !== "variables" &&
          sourceRaw !== "node-output" &&
          sourceRaw !== "workflow-output" &&
          sourceRaw !== "human-input" &&
          sourceRaw !== "conversation-transcript"
        ) {
          issues.push(
            makeIssue(
              "error",
              `${entryPath}.source`,
              "must be a valid binding source",
            ),
          );
          return;
        }

        if (targetPath === null) {
          return;
        }

        const sourceRef = entry["sourceRef"];
        const sourcePath = entry["sourcePath"];
        const required = entry["required"];

        parsed.push({
          targetPath,
          source: sourceRaw,
          ...(typeof sourceRef === "string" || isRecord(sourceRef)
            ? { sourceRef }
            : {}),
          ...(typeof sourcePath === "string" ? { sourcePath } : {}),
          ...(typeof required === "boolean" ? { required } : {}),
        });
      });
      argumentBindings = parsed;
    }
  }

  const templateEngineRaw = payload["templateEngine"];
  const templateEngine =
    typeof templateEngineRaw === "string" ? templateEngineRaw : undefined;
  const workingDirectory = normalizeWorkingDirectoryField(
    payload["workingDirectory"],
    `${path}.workingDirectory`,
    issues,
  );

  const outputContract = normalizeNodeOutputContract(
    payload["output"],
    `${path}.output`,
    issues,
  );

  if (nodeType === "command" && command === undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.command`,
        "is required when nodeType is 'command'",
      ),
    );
  }
  if (nodeType === "container" && container === undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.container`,
        "is required when nodeType is 'container'",
      ),
    );
  }
  if (durability !== undefined && nodeType !== "container") {
    issues.push(
      makeIssue(
        "error",
        `${path}.durability`,
        "is currently valid only for container nodes",
      ),
    );
  }
  if (userAction !== undefined && nodeType !== "user-action") {
    issues.push(
      makeIssue(
        "error",
        `${path}.userAction`,
        "is valid only when nodeType is 'user-action'",
      ),
    );
  }
  if (nodeType === "user-action" && userAction === undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.userAction`,
        "is required when nodeType is 'user-action'",
      ),
    );
  }
  if (nodeType === "user-action" && model !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.model`,
        "must be omitted when nodeType is 'user-action'",
      ),
    );
  }
  if (nodeType === "user-action" && executionBackend !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.executionBackend`,
        "must be omitted when nodeType is 'user-action'",
      ),
    );
  }
  if (nodeType === "user-action" && sessionPolicy !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.sessionPolicy`,
        "must be omitted when nodeType is 'user-action'",
      ),
    );
  }
  if (nodeType === "user-action" && command !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.command`,
        "must be omitted when nodeType is 'user-action'",
      ),
    );
  }
  if (nodeType === "user-action" && container !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.container`,
        "must be omitted when nodeType is 'user-action'",
      ),
    );
  }
  if (nodeType === "user-action" && durability !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.durability`,
        "must be omitted when nodeType is 'user-action'",
      ),
    );
  }
  if (
    nodeType === "user-action" &&
    promptTemplate === undefined &&
    promptTemplateFile === undefined
  ) {
    issues.push(
      makeIssue(
        "error",
        `${path}.promptTemplate`,
        "must be provided inline or by promptTemplateFile when nodeType is 'user-action'",
      ),
    );
  }

  if (
    id === null ||
    variables === null ||
    nodeType === "addon" ||
    (nodeType === "agent" &&
      (model === undefined || promptTemplate === undefined) &&
      !allowsManagerCodePathDefaults)
  ) {
    return null;
  }

  return {
    id,
    ...(description === undefined ? {} : { description }),
    ...(nodeType === "agent" ? {} : { nodeType }),
    ...(managerType === undefined ? {} : { managerType }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(model === undefined ? {} : { model }),
    ...(executionBackend === undefined ? {} : { executionBackend }),
    ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
    ...(systemPromptTemplate === undefined ? {} : { systemPromptTemplate }),
    ...(systemPromptTemplateFile === undefined
      ? {}
      : { systemPromptTemplateFile }),
    ...(promptTemplate === undefined ? {} : { promptTemplate }),
    ...(promptTemplateFile === undefined ? {} : { promptTemplateFile }),
    ...(sessionStartPromptTemplate === undefined
      ? {}
      : { sessionStartPromptTemplate }),
    ...(sessionStartPromptTemplateFile === undefined
      ? {}
      : { sessionStartPromptTemplateFile }),
    ...(promptVariants === undefined ? {} : { promptVariants }),
    variables,
    ...(command === undefined ? {} : { command }),
    ...(container === undefined ? {} : { container }),
    ...(durability === undefined ? {} : { durability }),
    ...(userAction === undefined ? {} : { userAction }),
    ...(argumentsTemplate === undefined ? {} : { argumentsTemplate }),
    ...(argumentBindings === undefined ? {} : { argumentBindings }),
    ...(templateEngine === undefined ? {} : { templateEngine }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(outputContract === undefined ? {} : { output: outputContract }),
  };
}

export function normalizeUserActionNodeConfig(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): UserActionNodeConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return undefined;
  }

  const allowedKeys = new Set([
    "messageToolIds",
    "notificationToolIds",
    "replyPolicy",
    "allowStructuredReply",
    "allowFreeTextReply",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported userAction field",
        ),
      );
    }
  }

  const messageToolIds = normalizeNamedStringArrayField(
    value,
    "messageToolIds",
    path,
    issues,
  );
  const notificationToolIds = normalizeOptionalNamedStringArrayField(
    value,
    "notificationToolIds",
    path,
    issues,
  );

  if (messageToolIds !== null && messageToolIds.length === 0) {
    issues.push(
      makeIssue(
        "error",
        `${path}.messageToolIds`,
        "must contain at least one tool id",
      ),
    );
  }

  const replyPolicyRaw = value["replyPolicy"];
  let replyPolicy: UserActionNodeConfig["replyPolicy"];
  if (replyPolicyRaw !== undefined) {
    if (replyPolicyRaw === "first-valid-reply-wins") {
      replyPolicy = replyPolicyRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.replyPolicy`,
          "must be 'first-valid-reply-wins' when provided",
        ),
      );
    }
  }

  const allowStructuredReply = normalizeOptionalBooleanField(
    value,
    "allowStructuredReply",
    path,
    issues,
  );
  const allowFreeTextReply = normalizeOptionalBooleanField(
    value,
    "allowFreeTextReply",
    path,
    issues,
  );

  if (messageToolIds === null) {
    return undefined;
  }

  return {
    messageToolIds,
    ...(notificationToolIds === undefined ? {} : { notificationToolIds }),
    ...(replyPolicy === undefined ? {} : { replyPolicy }),
    ...(allowStructuredReply === undefined ? {} : { allowStructuredReply }),
    ...(allowFreeTextReply === undefined ? {} : { allowFreeTextReply }),
  };
}

export function normalizeNodeOutputContract(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): NodeOutputContract | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object"));
    return undefined;
  }

  const allowedKeys = new Set([
    "description",
    "jsonSchema",
    "maxValidationAttempts",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported output contract field",
        ),
      );
    }
  }
  const hasDescriptionKey = Object.hasOwn(value, "description");
  const hasJsonSchemaKey = Object.hasOwn(value, "jsonSchema");

  const descriptionRaw = value["description"];
  const description =
    typeof descriptionRaw === "string" && descriptionRaw.trim().length > 0
      ? descriptionRaw
      : undefined;
  if (descriptionRaw !== undefined && typeof descriptionRaw !== "string") {
    issues.push(
      makeIssue(
        "error",
        `${path}.description`,
        "must be a string when provided",
      ),
    );
  } else if (typeof descriptionRaw === "string" && description === undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.description`,
        "must be a non-empty string when provided",
      ),
    );
  }

  const jsonSchemaRaw = value["jsonSchema"];
  let jsonSchema: JsonObject | undefined;
  if (jsonSchemaRaw !== undefined) {
    if (!isRecord(jsonSchemaRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.jsonSchema`,
          "must be an object when provided",
        ),
      );
    } else {
      const schemaIssues = validateJsonSchemaDefinition(
        jsonSchemaRaw as JsonObject,
      );
      schemaIssues.forEach((entry) => {
        issues.push(
          makeIssue(
            "error",
            `${path}.jsonSchema${entry.path === "$schema" ? "" : entry.path.slice("$schema".length)}`,
            entry.message,
          ),
        );
      });
      if (schemaIssues.length === 0) {
        jsonSchema = jsonSchemaRaw as JsonObject;
      }
    }
  }

  const maxValidationAttemptsRaw = value["maxValidationAttempts"];
  let maxValidationAttempts: number | undefined;
  if (maxValidationAttemptsRaw !== undefined) {
    if (
      typeof maxValidationAttemptsRaw === "number" &&
      Number.isInteger(maxValidationAttemptsRaw) &&
      maxValidationAttemptsRaw > 0
    ) {
      maxValidationAttempts = maxValidationAttemptsRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.maxValidationAttempts`,
          "must be an integer > 0 when provided",
        ),
      );
    }
  }

  if (!hasDescriptionKey && !hasJsonSchemaKey) {
    issues.push(
      makeIssue(
        "error",
        path,
        "must define output.description and/or output.jsonSchema when provided",
      ),
    );
  }

  return {
    ...(description === undefined ? {} : { description }),
    ...(jsonSchema === undefined ? {} : { jsonSchema }),
    ...(maxValidationAttempts === undefined ? {} : { maxValidationAttempts }),
  };
}
