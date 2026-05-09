import {
  createAsyncNodeAddonRegistry,
  createNodeAddonRegistry,
  resolveNodeAddonPayload,
  resolveNodeAddonPayloadAsync,
} from "./node-addons";
import { synthesizeInlineNodeFile } from "./authored-node";
import type {
  AsyncNodeAddonPayloadResolver,
  NodeAddonPayloadResolver,
  NodePayload,
  NodePromptVariant,
  NodeRole,
  ValidationIssue,
  WorkflowJson,
  WorkflowStepRef,
} from "./types";
import {
  isRecord,
  makeIssue,
  type WorkflowValidationOptions,
} from "./validate-helpers";
import { normalizeNodePayload } from "./validate-node-payload";

interface NodeStepRoleUsage {
  readonly manager: boolean;
  readonly worker: boolean;
}

export function resolveWorkflowStepExecutionRole(
  workflow: Pick<WorkflowJson, "managerStepId">,
  step: Pick<WorkflowStepRef, "id" | "role">,
): NodeRole {
  return (
    step.role ?? (workflow.managerStepId === step.id ? "manager" : "worker")
  );
}

export function applyPromptVariantTemplateOverride(input: {
  readonly payload: NodePayload;
  readonly variant: NodePromptVariant;
  readonly templateField:
    | "systemPromptTemplate"
    | "promptTemplate"
    | "sessionStartPromptTemplate";
  readonly templateFileField:
    | "systemPromptTemplateFile"
    | "promptTemplateFile"
    | "sessionStartPromptTemplateFile";
}): NodePayload {
  const variantTemplate = input.variant[input.templateField];
  const variantTemplateFile = input.variant[input.templateFileField];
  if (variantTemplate === undefined && variantTemplateFile === undefined) {
    return input.payload;
  }

  const {
    [input.templateField]: _removedTemplate,
    [input.templateFileField]: _removedTemplateFile,
    ...payloadWithoutTemplatePair
  } = input.payload;

  return {
    ...payloadWithoutTemplatePair,
    ...(variantTemplate === undefined
      ? {}
      : { [input.templateField]: variantTemplate }),
    ...(variantTemplateFile === undefined
      ? {}
      : { [input.templateFileField]: variantTemplateFile }),
  };
}

export function collectStepNodeRoleUsage(
  workflow: Pick<WorkflowJson, "managerStepId" | "steps">,
): ReadonlyMap<string, NodeStepRoleUsage> {
  const usage = new Map<string, NodeStepRoleUsage>();

  for (const step of workflow.steps ?? []) {
    const role = resolveWorkflowStepExecutionRole(workflow, step);
    const current = usage.get(step.nodeId) ?? {
      manager: false,
      worker: false,
    };
    usage.set(step.nodeId, {
      manager: current.manager || role === "manager",
      worker: current.worker || role === "worker",
    });
  }

  return usage;
}

export function validateResolvedAddonPayload(input: {
  readonly authoredAddonName: string;
  readonly expectedNodeId: string;
  readonly payload: unknown;
  readonly path: string;
  readonly issues: ValidationIssue[];
}): boolean {
  const payload = input.payload;
  let valid = true;
  if (!isRecord(payload)) {
    input.issues.push(
      makeIssue("error", `${input.path}.payload`, "must be an object"),
    );
    return false;
  }
  if (payload["id"] !== input.expectedNodeId) {
    input.issues.push(
      makeIssue(
        "error",
        `${input.path}.payload.id`,
        `resolved add-on payload id must be '${input.expectedNodeId}'`,
      ),
    );
    valid = false;
  }
  if (
    !input.authoredAddonName.startsWith("divedra/") &&
    payload["nodeType"] === "addon"
  ) {
    input.issues.push(
      makeIssue(
        "error",
        `${input.path}.payload.nodeType`,
        "third-party add-on resolvers must return an ordinary agent, command, container, or user-action payload",
      ),
    );
    valid = false;
  }
  if (
    !input.authoredAddonName.startsWith("divedra/") &&
    payload["addon"] !== undefined
  ) {
    input.issues.push(
      makeIssue(
        "error",
        `${input.path}.payload.addon`,
        "third-party add-on resolvers must not return runtime add-on metadata",
      ),
    );
    valid = false;
  }
  return valid;
}

export function resolveSyncNodeAddonResolvers(
  options: WorkflowValidationOptions,
  issues: ValidationIssue[],
): readonly NodeAddonPayloadResolver[] | undefined {
  if (
    options.asyncNodeAddonResolvers !== undefined &&
    options.asyncNodeAddonResolvers.length > 0
  ) {
    issues.push(
      makeIssue(
        "error",
        "workflow.nodes",
        "async node add-on resolvers require validateWorkflowBundleAsync or loadWorkflowFromDisk",
      ),
    );
  }

  return options.nodeAddons === undefined || options.nodeAddons.length === 0
    ? options.nodeAddonResolvers
    : [
        ...(options.nodeAddonResolvers ?? []),
        createNodeAddonRegistry(options.nodeAddons),
      ];
}

export function resolveAsyncNodeAddonResolvers(
  options: WorkflowValidationOptions,
): readonly AsyncNodeAddonPayloadResolver[] | undefined {
  const resolvers: AsyncNodeAddonPayloadResolver[] = [
    ...(options.nodeAddonResolvers ?? []),
    ...(options.asyncNodeAddonResolvers ?? []),
  ];
  if (options.nodeAddons !== undefined && options.nodeAddons.length > 0) {
    resolvers.push(createAsyncNodeAddonRegistry(options.nodeAddons));
  }
  return resolvers.length === 0 ? undefined : resolvers;
}

export function applyStepPromptVariant(input: {
  readonly basePayload: NodePayload;
  readonly workflow: Pick<WorkflowJson, "managerStepId">;
  readonly step: WorkflowStepRef;
  readonly issues: ValidationIssue[];
  readonly stepPath: string;
}): NodePayload {
  const { basePayload, step } = input;
  const stepRole = resolveWorkflowStepExecutionRole(input.workflow, step);
  if (stepRole !== "manager" && basePayload.managerType !== undefined) {
    input.issues.push(
      makeIssue(
        "error",
        `${input.stepPath}.nodeId`,
        `references node '${step.nodeId}' whose payload declares managerType; managerType is valid only for manager-role steps`,
      ),
    );
  }

  const resolvedPayload: NodePayload = {
    ...basePayload,
    id: step.id,
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    ...(step.sessionPolicy?.mode === undefined
      ? {}
      : { sessionPolicy: { mode: step.sessionPolicy.mode } }),
  };
  const payloadWithResolvedManagerType =
    stepRole === "manager"
      ? {
          ...resolvedPayload,
          managerType: basePayload.managerType ?? "code",
        }
      : (() => {
          const { managerType: _managerType, ...payloadWithoutManagerType } =
            resolvedPayload;
          return payloadWithoutManagerType;
        })();

  if (step.promptVariant === undefined) {
    return payloadWithResolvedManagerType;
  }

  const variant = basePayload.promptVariants?.[step.promptVariant];
  if (variant === undefined) {
    input.issues.push(
      makeIssue(
        "error",
        `${input.stepPath}.promptVariant`,
        `must reference a promptVariants entry on node '${step.nodeId}'`,
      ),
    );
    return payloadWithResolvedManagerType;
  }

  return [
    {
      templateField: "systemPromptTemplate" as const,
      templateFileField: "systemPromptTemplateFile" as const,
    },
    {
      templateField: "promptTemplate" as const,
      templateFileField: "promptTemplateFile" as const,
    },
    {
      templateField: "sessionStartPromptTemplate" as const,
      templateFileField: "sessionStartPromptTemplateFile" as const,
    },
  ].reduce(
    (payload, templatePair) =>
      applyPromptVariantTemplateOverride({
        payload,
        variant,
        templateField: templatePair.templateField,
        templateFileField: templatePair.templateFileField,
      }),
    payloadWithResolvedManagerType,
  );
}

export function buildStepAddressedNodePayloadsSync(input: {
  readonly workflow: WorkflowJson;
  readonly nodePayloadsRaw: Readonly<Record<string, unknown>>;
  readonly issues: ValidationIssue[];
  readonly options: WorkflowValidationOptions;
  readonly nodeAddonResolvers: readonly NodeAddonPayloadResolver[] | undefined;
}): Record<string, NodePayload> {
  const nodePayloads: Record<string, NodePayload> = {};
  const nodeRegistry = input.workflow.nodeRegistry ?? [];
  const steps = input.workflow.steps ?? [];
  const basePayloadsByRegistryId = new Map<string, NodePayload>();
  const nodeRoleUsage = collectStepNodeRoleUsage(input.workflow);

  nodeRegistry.forEach((node, index) => {
    const usage = nodeRoleUsage.get(node.id);
    if (node.addon !== undefined) {
      const resolved = resolveNodeAddonPayload({
        nodeId: node.id,
        addon: node.addon,
        path: `workflow.nodes[${index}].addon`,
        ...(input.options.resolvedWorkflowSource === undefined
          ? {}
          : { workflowSource: input.options.resolvedWorkflowSource }),
        options: input.options,
        ...(input.nodeAddonResolvers === undefined
          ? {}
          : { thirdPartyResolvers: input.nodeAddonResolvers }),
      });
      input.issues.push(...(resolved.issues ?? []));
      if (
        resolved.payload !== undefined &&
        validateResolvedAddonPayload({
          authoredAddonName: node.addon.name,
          expectedNodeId: node.id,
          payload: resolved.payload,
          path: `workflow.nodes[${index}].addon`,
          issues: input.issues,
        })
      ) {
        const normalizedPayload = node.addon.name.startsWith("divedra/")
          ? (resolved.payload as NodePayload)
          : normalizeNodePayload({
              nodeId: node.id,
              nodeFile: node.nodeFile ?? synthesizeInlineNodeFile(node.id),
              payload: resolved.payload,
              issues: input.issues,
              path: `workflow.nodes[${index}].addon.payload`,
              allowManagerCodePathDefaults:
                usage?.manager === true && usage.worker !== true,
            });
        if (normalizedPayload !== null) {
          basePayloadsByRegistryId.set(node.id, normalizedPayload);
          nodePayloads[node.id] = normalizedPayload;
        }
      }
      return;
    }

    if (node.nodeFile === undefined) {
      return;
    }
    const payloadRaw = input.nodePayloadsRaw[node.nodeFile];
    if (payloadRaw === undefined) {
      input.issues.push(
        makeIssue(
          "error",
          `nodePayloads.${node.nodeFile}`,
          "node payload file is missing",
        ),
      );
      return;
    }
    const payload = normalizeNodePayload({
      nodeId: node.id,
      nodeFile: node.nodeFile,
      payload: payloadRaw,
      issues: input.issues,
      allowManagerCodePathDefaults:
        usage?.manager === true && usage.worker !== true,
    });
    if (payload !== null) {
      basePayloadsByRegistryId.set(node.id, payload);
      nodePayloads[node.id] = payload;
      nodePayloads[node.nodeFile] = payload;
    }
  });

  steps.forEach((step, index) => {
    const basePayload = basePayloadsByRegistryId.get(step.nodeId);
    if (basePayload === undefined) {
      return;
    }
    nodePayloads[step.id] = applyStepPromptVariant({
      basePayload,
      workflow: input.workflow,
      step,
      issues: input.issues,
      stepPath: `workflow.steps[${index}]`,
    });
  });

  return nodePayloads;
}

export async function buildStepAddressedNodePayloadsAsync(input: {
  readonly workflow: WorkflowJson;
  readonly nodePayloadsRaw: Readonly<Record<string, unknown>>;
  readonly issues: ValidationIssue[];
  readonly options: WorkflowValidationOptions;
  readonly nodeAddonResolvers:
    | readonly AsyncNodeAddonPayloadResolver[]
    | undefined;
}): Promise<Record<string, NodePayload>> {
  const nodePayloads: Record<string, NodePayload> = {};
  const nodeRegistry = input.workflow.nodeRegistry ?? [];
  const steps = input.workflow.steps ?? [];
  const basePayloadsByRegistryId = new Map<string, NodePayload>();
  const nodeRoleUsage = collectStepNodeRoleUsage(input.workflow);

  for (const [index, node] of nodeRegistry.entries()) {
    const usage = nodeRoleUsage.get(node.id);
    if (node.addon !== undefined) {
      const resolved = await resolveNodeAddonPayloadAsync({
        nodeId: node.id,
        addon: node.addon,
        path: `workflow.nodes[${index}].addon`,
        ...(input.options.resolvedWorkflowSource === undefined
          ? {}
          : { workflowSource: input.options.resolvedWorkflowSource }),
        options: input.options,
        ...(input.nodeAddonResolvers === undefined
          ? {}
          : { thirdPartyResolvers: input.nodeAddonResolvers }),
      });
      input.issues.push(...(resolved.issues ?? []));
      if (
        resolved.payload !== undefined &&
        validateResolvedAddonPayload({
          authoredAddonName: node.addon.name,
          expectedNodeId: node.id,
          payload: resolved.payload,
          path: `workflow.nodes[${index}].addon`,
          issues: input.issues,
        })
      ) {
        const normalizedPayload = node.addon.name.startsWith("divedra/")
          ? (resolved.payload as NodePayload)
          : normalizeNodePayload({
              nodeId: node.id,
              nodeFile: node.nodeFile ?? synthesizeInlineNodeFile(node.id),
              payload: resolved.payload,
              issues: input.issues,
              path: `workflow.nodes[${index}].addon.payload`,
              allowManagerCodePathDefaults:
                usage?.manager === true && usage.worker !== true,
            });
        if (normalizedPayload !== null) {
          basePayloadsByRegistryId.set(node.id, normalizedPayload);
          nodePayloads[node.id] = normalizedPayload;
        }
      }
      continue;
    }

    if (node.nodeFile === undefined) {
      continue;
    }
    const payloadRaw = input.nodePayloadsRaw[node.nodeFile];
    if (payloadRaw === undefined) {
      input.issues.push(
        makeIssue(
          "error",
          `nodePayloads.${node.nodeFile}`,
          "node payload file is missing",
        ),
      );
      continue;
    }
    const payload = normalizeNodePayload({
      nodeId: node.id,
      nodeFile: node.nodeFile,
      payload: payloadRaw,
      issues: input.issues,
      allowManagerCodePathDefaults:
        usage?.manager === true && usage.worker !== true,
    });
    if (payload !== null) {
      basePayloadsByRegistryId.set(node.id, payload);
      nodePayloads[node.id] = payload;
      nodePayloads[node.nodeFile] = payload;
    }
  }

  steps.forEach((step, index) => {
    const basePayload = basePayloadsByRegistryId.get(step.nodeId);
    if (basePayload === undefined) {
      return;
    }
    nodePayloads[step.id] = applyStepPromptVariant({
      basePayload,
      workflow: input.workflow,
      step,
      issues: input.issues,
      stepPath: `workflow.steps[${index}]`,
    });
  });

  return nodePayloads;
}
