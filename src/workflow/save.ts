import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJsonFile } from "../shared/fs";
import {
  cloneNodeTemplateAwarePayload,
  listNodeTemplateFieldContainers,
  NODE_TEMPLATE_FIELD_SPECS,
} from "./node-template-fields";
import { resolveWorkflowRelativePath } from "./prompt-template-file";
import { err, ok, type Result } from "./result";
import { isSafeWorkflowName, resolveEffectiveRoots } from "./paths";
import {
  collectStepAddressedAuthoredWorkflowFieldIssues,
  isNormalizedStepAddressedWorkflow,
  stripNormalizedWorkflowFieldsForPersistence,
} from "./authored-workflow";
import { validateWorkflowBundleAsync } from "./validate";
import {
  collectPromptTemplateFiles,
  collectWorkflowRevisionNodeFiles,
  collectWorkflowRevisionStepFiles,
  computeWorkflowRevisionFromFiles,
} from "./revision";
import { remapAuthoredNodePayloadsByNodeFile } from "./authored-node";
import type { LoadOptions } from "./types";
import {
  type AuthoredWorkflowRecord,
  type SaveWorkflowFailure,
  OBSOLETE_WORKFLOW_VISUALIZATION_FILE,
  WORKFLOW_DEFINITION_FILE,
  isRecord,
  createPersistedWorkflowJson,
  createStepAddressedWorkflowForValidation,
  collectReferencedNodePayloads,
  collectAuthoredReferencedNodePayloads,
  preferStepAddressedRegistryIdPayloads,
  readExistingAuthoredWorkflow,
  loadExistingAuthoredWorkflowFileState,
  hasStepAddressedDerivedNodePayload,
  persistStepDefinition,
  persistNodePayload,
  removeStaleWorkflowFiles,
  collectReferencedPromptTemplateFiles,
} from "./save-helpers";

export type {
  SaveWorkflowInput,
  SaveWorkflowSuccess,
  SaveWorkflowFailure,
} from "./save-helpers";

async function hydratePromptTemplateFilesForValidation(input: {
  readonly workflowDirectory: string;
  readonly nodePayloads: Readonly<Record<string, unknown>>;
}): Promise<Result<Readonly<Record<string, unknown>>, SaveWorkflowFailure>> {
  const hydrated: Record<string, unknown> = { ...input.nodePayloads };

  for (const [nodeFile, payload] of Object.entries(input.nodePayloads)) {
    if (typeof payload !== "object" || payload === null) {
      continue;
    }

    const payloadRecord = payload as Record<string, unknown>;
    const hydratedPayload = cloneNodeTemplateAwarePayload(payloadRecord);
    for (const {
      path: containerPath,
      record,
    } of listNodeTemplateFieldContainers(hydratedPayload)) {
      for (const spec of NODE_TEMPLATE_FIELD_SPECS) {
        const templateText = record[spec.textField];
        if (typeof templateText === "string" && templateText.length > 0) {
          continue;
        }

        const templateFile = record[spec.fileField];
        if (typeof templateFile !== "string" || templateFile.length === 0) {
          continue;
        }

        const resolvedPath = resolveWorkflowRelativePath(
          input.workflowDirectory,
          templateFile,
        );
        if (!resolvedPath.ok) {
          return err({
            code: "VALIDATION",
            message: "workflow validation failed",
            issues: [
              {
                severity: "error",
                path:
                  containerPath.length === 0
                    ? `bundle.nodePayloads.${nodeFile}.${spec.fileField}`
                    : `bundle.nodePayloads.${nodeFile}.${containerPath}.${spec.fileField}`,
                message: resolvedPath.error.message,
              },
            ],
          });
        }

        try {
          record[spec.textField] = await readFile(resolvedPath.value, "utf8");
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : "unknown error";
          if (message.includes("ENOENT")) {
            return err({
              code: "VALIDATION",
              message: "workflow validation failed",
              issues: [
                {
                  severity: "error",
                  path:
                    containerPath.length === 0
                      ? `bundle.nodePayloads.${nodeFile}.${spec.textField}`
                      : `bundle.nodePayloads.${nodeFile}.${containerPath}.${spec.textField}`,
                  message: `must be provided inline or by an existing ${spec.fileField} '${templateFile}'`,
                },
              ],
            });
          }

          return err({
            code: "IO",
            message: `failed reading ${spec.fileField} '${templateFile}' for validation: ${message}`,
          });
        }
      }
    }

    hydrated[nodeFile] = hydratedPayload;
  }

  return ok(hydrated);
}

export async function saveWorkflowToDisk(
  workflowName: string,
  input: {
    readonly workflow: unknown;
    readonly nodePayloads: Readonly<Record<string, unknown>>;
    readonly expectedRevision?: string;
  },
  options: LoadOptions = {},
): Promise<
  Result<
    {
      readonly workflowName: string;
      readonly workflowDirectory: string;
      readonly revision: string;
    },
    SaveWorkflowFailure
  >
> {
  if (!isSafeWorkflowName(workflowName)) {
    return err({
      code: "INVALID_WORKFLOW_NAME",
      message: `invalid workflow name '${workflowName}'`,
    });
  }

  const roots = resolveEffectiveRoots(options);
  const workflowDirectory =
    options.workflowBundleDirectoryOverride !== undefined
      ? path.resolve(
          options.cwd ?? process.cwd(),
          options.workflowBundleDirectoryOverride,
        )
      : path.join(roots.workflowRoot, workflowName);
  const existingAuthoredWorkflow =
    await readExistingAuthoredWorkflow(workflowDirectory);
  if (!existingAuthoredWorkflow.ok) {
    return err(existingAuthoredWorkflow.error);
  }

  const normalizedInputWorkflow = isNormalizedStepAddressedWorkflow(
    input.workflow,
  )
    ? input.workflow
    : undefined;
  const stepAddressedLegacyIssues =
    normalizedInputWorkflow !== undefined
      ? collectStepAddressedAuthoredWorkflowFieldIssues(input.workflow)
      : [];
  const authoredWorkflow =
    normalizedInputWorkflow === undefined
      ? stripNormalizedWorkflowFieldsForPersistence(input.workflow)
      : createStepAddressedWorkflowForValidation(normalizedInputWorkflow);
  const normalizedNodePayloads = preferStepAddressedRegistryIdPayloads(
    authoredWorkflow,
    remapAuthoredNodePayloadsByNodeFile(authoredWorkflow, input.nodePayloads),
  );
  const authoredReferencedNodePayloads = collectAuthoredReferencedNodePayloads(
    authoredWorkflow,
    normalizedNodePayloads,
  );
  const validationNodePayloads = await hydratePromptTemplateFilesForValidation({
    workflowDirectory,
    nodePayloads: authoredReferencedNodePayloads,
  });
  if (!validationNodePayloads.ok) {
    return err(validationNodePayloads.error);
  }

  const validation = await validateWorkflowBundleAsync(
    {
      workflow: authoredWorkflow,
      nodePayloads: validationNodePayloads.value,
    },
    {
      ...options,
      allowResolvedStepFileFields: true,
    },
  );

  if (!validation.ok) {
    return err({
      code: "VALIDATION",
      message: "workflow validation failed",
      issues: [...stepAddressedLegacyIssues, ...validation.error],
    });
  }
  if (stepAddressedLegacyIssues.length > 0) {
    return err({
      code: "VALIDATION",
      message: "workflow validation failed",
      issues: stepAddressedLegacyIssues,
    });
  }

  const nodeFiles = collectWorkflowRevisionNodeFiles(validation.value.workflow);
  const stepFiles = collectWorkflowRevisionStepFiles(validation.value.workflow);
  const referencedNodePayloads = collectReferencedNodePayloads({
    workflow: validation.value.workflow,
    nodePayloads: normalizedNodePayloads,
  });
  const existingWorkflowFileState = await loadExistingAuthoredWorkflowFileState(
    {
      workflowDirectory,
      existingAuthoredWorkflow: existingAuthoredWorkflow.value,
    },
  );
  if (!existingWorkflowFileState.ok) {
    return err(existingWorkflowFileState.error);
  }

  const currentRevision = await computeWorkflowRevisionFromFiles(
    workflowDirectory,
    existingWorkflowFileState.value.existingAuthoredWorkflowRecord === undefined
      ? nodeFiles
      : existingWorkflowFileState.value.existingNodeFiles,
    existingWorkflowFileState.value.existingAuthoredWorkflowRecord === undefined
      ? [...stepFiles, ...collectPromptTemplateFiles(referencedNodePayloads)]
      : [
          ...existingWorkflowFileState.value.existingStepFiles,
          ...existingWorkflowFileState.value.existingPromptTemplateFiles,
        ],
  );
  if (input.expectedRevision !== undefined) {
    if (
      currentRevision.ok &&
      currentRevision.value !== input.expectedRevision
    ) {
      return err({
        code: "CONFLICT",
        message: "workflow revision conflict",
        currentRevision: currentRevision.value,
      });
    }
  }

  try {
    const persistedWorkflow = createPersistedWorkflowJson({
      workflow: validation.value.workflow,
      authoredWorkflow: isRecord(authoredWorkflow)
        ? (authoredWorkflow as AuthoredWorkflowRecord)
        : undefined,
    });
    await mkdir(workflowDirectory, { recursive: true });
    await atomicWriteJsonFile(
      path.join(workflowDirectory, WORKFLOW_DEFINITION_FILE),
      persistedWorkflow,
    );
    if (validation.value.workflow.steps !== undefined) {
      for (const step of validation.value.workflow.steps) {
        if (step.stepFile === undefined) {
          continue;
        }
        await persistStepDefinition({
          workflowDirectory,
          stepFile: step.stepFile,
          step,
        });
      }
    }
    const nodesToPersist =
      validation.value.workflow.nodeRegistry?.map((node) => ({
        id: node.id,
        ...(node.nodeFile === undefined ? {} : { nodeFile: node.nodeFile }),
        ...(node.addon === undefined ? {} : { addon: node.addon }),
      })) ?? validation.value.workflow.nodes;
    for (const node of nodesToPersist) {
      if (node.addon !== undefined) {
        continue;
      }
      if (node.nodeFile === undefined) {
        continue;
      }
      const prefersNodeFilePayload =
        validation.value.workflow.nodeRegistry !== undefined &&
        hasStepAddressedDerivedNodePayload({
          workflow: validation.value.workflow,
          nodeId: node.id,
          nodeFile: node.nodeFile,
          nodePayloads: normalizedNodePayloads,
        });
      const payload =
        validation.value.workflow.nodeRegistry !== undefined
          ? prefersNodeFilePayload
            ? (normalizedNodePayloads[node.nodeFile] ??
              normalizedNodePayloads[node.id])
            : (normalizedNodePayloads[node.id] ??
              normalizedNodePayloads[node.nodeFile])
          : (normalizedNodePayloads[node.nodeFile] ??
            normalizedNodePayloads[node.id]);
      if (payload === undefined) {
        return err({
          code: "VALIDATION",
          message: `missing node payload for ${node.nodeFile}`,
          issues: [
            {
              severity: "error",
              path: `bundle.nodePayloads.${node.nodeFile}`,
              message: "required payload is missing",
            },
          ],
        });
      }
      await persistNodePayload({
        workflowDirectory,
        nodeFile: node.nodeFile,
        payload,
      });
    }
    await removeStaleWorkflowFiles({
      workflowDirectory,
      existingNodeFiles: existingWorkflowFileState.value.existingNodeFiles,
      existingStepFiles: existingWorkflowFileState.value.existingStepFiles,
      existingPromptTemplateFiles:
        existingWorkflowFileState.value.existingPromptTemplateFiles,
      persistedNodeFiles: nodeFiles,
      persistedStepFiles: stepFiles,
      persistedPromptTemplateFiles: collectReferencedPromptTemplateFiles(
        referencedNodePayloads,
      ),
    });
    await rm(
      path.join(workflowDirectory, OBSOLETE_WORKFLOW_VISUALIZATION_FILE),
      {
        force: true,
      },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    return err({
      code: "IO",
      message: `failed saving workflow files: ${message}`,
    });
  }

  const revision = await computeWorkflowRevisionFromFiles(
    workflowDirectory,
    nodeFiles,
    [...stepFiles, ...collectPromptTemplateFiles(referencedNodePayloads)],
  );
  if (!revision.ok) {
    return err({ code: "IO", message: revision.error.message });
  }

  return ok({ workflowName, workflowDirectory, revision: revision.value });
}
