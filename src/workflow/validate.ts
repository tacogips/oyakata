import { remapAuthoredNodePayloadsByNodeFile } from "./authored-node";
import {
  REJECTED_AUTHORED_DISALLOWED_TOP_LEVEL_FIELD_KEYS,
  REJECTED_AUTHORED_STEP_ADDRESSED_DISALLOWED_TOP_LEVEL_KEYS,
  REJECTED_AUTHORED_STEP_ADDRESSED_EDGES_FIELD_MESSAGE,
  REJECTED_AUTHORED_STEP_ADDRESSED_EXTRA_TOP_LEVEL_KEYS,
  REJECTED_AUTHORED_TOP_LEVEL_SCHEMA_FIELD_MESSAGE,
} from "./authored-workflow";
import {
  resolveNodeAddonPayload,
  resolveNodeAddonPayloadAsync,
} from "./node-addons";
import { err, ok, type Result } from "./result";
import type {
  NormalizedWorkflowBundle,
  NodePayload,
  ValidationIssue,
} from "./types";
import { makeIssue, type WorkflowValidationOptions } from "./validate-helpers";
import { normalizeNodePayload } from "./validate-node-payload";
import { normalizeWorkflow } from "./validate-workflow";
import {
  runSemanticValidation,
  validateCrossWorkflowCalleeEntryAlignment,
  validateCrossWorkflowCalleeEntryAlignmentSync,
} from "./validate-semantic";
import {
  buildStepAddressedNodePayloadsAsync,
  buildStepAddressedNodePayloadsSync,
  resolveAsyncNodeAddonResolvers,
  resolveSyncNodeAddonResolvers,
  validateResolvedAddonPayload,
} from "./validate-bundle-assembly";

export {
  REJECTED_AUTHORED_DISALLOWED_TOP_LEVEL_FIELD_KEYS,
  REJECTED_AUTHORED_STEP_ADDRESSED_DISALLOWED_TOP_LEVEL_KEYS,
  REJECTED_AUTHORED_STEP_ADDRESSED_EDGES_FIELD_MESSAGE,
  REJECTED_AUTHORED_STEP_ADDRESSED_EXTRA_TOP_LEVEL_KEYS,
  REJECTED_AUTHORED_TOP_LEVEL_SCHEMA_FIELD_MESSAGE,
};

export type { WorkflowValidationOptions };
export { isStrictWorkflowAuthorshipValidation } from "./validate-helpers";

interface RawBundle {
  readonly workflow: unknown;
  readonly nodePayloads: Readonly<Record<string, unknown>>;
}

type ValidationResult = Result<
  NormalizedWorkflowBundle,
  readonly ValidationIssue[]
>;

interface ValidationSuccessDetails {
  readonly bundle: NormalizedWorkflowBundle;
  readonly issues: readonly ValidationIssue[];
}

export function validateWorkflowBundleDetailed(
  raw: RawBundle,
  options: WorkflowValidationOptions = {},
): Result<ValidationSuccessDetails, readonly ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const nodePayloadsRaw = remapAuthoredNodePayloadsByNodeFile(
    raw.workflow,
    raw.nodePayloads,
  );

  const workflow = normalizeWorkflow(raw.workflow, issues, options);

  const nodeAddonResolvers = resolveSyncNodeAddonResolvers(options, issues);

  let nodePayloads: Record<string, NodePayload> = {};
  if (workflow !== null && workflow.nodeRegistry !== undefined) {
    nodePayloads = buildStepAddressedNodePayloadsSync({
      workflow,
      nodePayloadsRaw,
      issues,
      options,
      nodeAddonResolvers,
    });
  } else if (workflow !== null) {
    workflow.nodes.forEach((node, index) => {
      if (node.addon !== undefined) {
        const resolved = resolveNodeAddonPayload({
          nodeId: node.id,
          addon: node.addon,
          path: `workflow.nodes[${index}].addon`,
          ...(options.resolvedWorkflowSource === undefined
            ? {}
            : { workflowSource: options.resolvedWorkflowSource }),
          options,
          ...(nodeAddonResolvers === undefined
            ? {}
            : { thirdPartyResolvers: nodeAddonResolvers }),
        });
        issues.push(...(resolved.issues ?? []));
        if (
          resolved.payload !== undefined &&
          validateResolvedAddonPayload({
            authoredAddonName: node.addon.name,
            expectedNodeId: node.id,
            payload: resolved.payload,
            path: `workflow.nodes[${index}].addon`,
            issues,
          })
        ) {
          if (node.addon.name.startsWith("divedra/")) {
            nodePayloads[node.id] = resolved.payload;
            return;
          }

          const normalizedPayload = normalizeNodePayload({
            nodeId: node.id,
            nodeFile: node.nodeFile,
            payload: resolved.payload,
            issues,
            path: `workflow.nodes[${index}].addon.payload`,
          });
          if (normalizedPayload !== null) {
            nodePayloads[node.id] = normalizedPayload;
          }
        }
        return;
      }

      const payloadRaw = nodePayloadsRaw[node.nodeFile];
      if (payloadRaw === undefined) {
        issues.push(
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
        issues,
      });
      if (payload !== null) {
        nodePayloads[node.id] = payload;
      }
    });
  }

  if (workflow === null) {
    return err(issues);
  }

  const bundle: NormalizedWorkflowBundle = {
    workflow,
    nodePayloads,
  };

  runSemanticValidation(bundle, issues);
  validateCrossWorkflowCalleeEntryAlignmentSync(bundle, options, issues);
  const allErrors = issues.filter((entry) => entry.severity === "error");
  if (allErrors.length > 0) {
    return err(issues);
  }

  return ok({ bundle, issues });
}

export async function validateWorkflowBundleDetailedAsync(
  raw: RawBundle,
  options: WorkflowValidationOptions = {},
): Promise<Result<ValidationSuccessDetails, readonly ValidationIssue[]>> {
  const issues: ValidationIssue[] = [];
  const nodePayloadsRaw = remapAuthoredNodePayloadsByNodeFile(
    raw.workflow,
    raw.nodePayloads,
  );

  const workflow = normalizeWorkflow(raw.workflow, issues, options);
  const nodeAddonResolvers = resolveAsyncNodeAddonResolvers(options);

  let nodePayloads: Record<string, NodePayload> = {};
  if (workflow !== null && workflow.nodeRegistry !== undefined) {
    nodePayloads = await buildStepAddressedNodePayloadsAsync({
      workflow,
      nodePayloadsRaw,
      issues,
      options,
      nodeAddonResolvers,
    });
  } else if (workflow !== null) {
    for (const [index, node] of workflow.nodes.entries()) {
      if (node.addon !== undefined) {
        const resolved = await resolveNodeAddonPayloadAsync({
          nodeId: node.id,
          addon: node.addon,
          path: `workflow.nodes[${index}].addon`,
          ...(options.resolvedWorkflowSource === undefined
            ? {}
            : { workflowSource: options.resolvedWorkflowSource }),
          options,
          ...(nodeAddonResolvers === undefined
            ? {}
            : { thirdPartyResolvers: nodeAddonResolvers }),
        });
        issues.push(...(resolved.issues ?? []));
        if (
          resolved.payload !== undefined &&
          validateResolvedAddonPayload({
            authoredAddonName: node.addon.name,
            expectedNodeId: node.id,
            payload: resolved.payload,
            path: `workflow.nodes[${index}].addon`,
            issues,
          })
        ) {
          if (node.addon.name.startsWith("divedra/")) {
            nodePayloads[node.id] = resolved.payload;
            continue;
          }

          const normalizedPayload = normalizeNodePayload({
            nodeId: node.id,
            nodeFile: node.nodeFile,
            payload: resolved.payload,
            issues,
            path: `workflow.nodes[${index}].addon.payload`,
          });
          if (normalizedPayload !== null) {
            nodePayloads[node.id] = normalizedPayload;
          }
        }
        continue;
      }

      const payloadRaw = nodePayloadsRaw[node.nodeFile];
      if (payloadRaw === undefined) {
        issues.push(
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
        issues,
      });
      if (payload !== null) {
        nodePayloads[node.id] = payload;
      }
    }
  }

  if (workflow === null) {
    return err(issues);
  }

  const bundle: NormalizedWorkflowBundle = {
    workflow,
    nodePayloads,
  };

  runSemanticValidation(bundle, issues);
  await validateCrossWorkflowCalleeEntryAlignment(bundle, options, issues);
  const allErrors = issues.filter((entry) => entry.severity === "error");
  if (allErrors.length > 0) {
    return err(issues);
  }

  return ok({ bundle, issues });
}

export function validateWorkflowBundle(
  raw: RawBundle,
  options: WorkflowValidationOptions = {},
): ValidationResult {
  const validation = validateWorkflowBundleDetailed(raw, options);
  if (!validation.ok) {
    return err(validation.error);
  }
  return ok(validation.value.bundle);
}

export async function validateWorkflowBundleAsync(
  raw: RawBundle,
  options: WorkflowValidationOptions = {},
): Promise<ValidationResult> {
  const validation = await validateWorkflowBundleDetailedAsync(raw, options);
  if (!validation.ok) {
    return err(validation.error);
  }
  return ok(validation.value.bundle);
}
