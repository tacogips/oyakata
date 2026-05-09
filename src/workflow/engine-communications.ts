import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJsonFile as writeJsonFile,
  atomicWriteTextFile as writeRawTextFile,
} from "../shared/fs";
import { normalizeExternalMailboxBusinessPayload } from "./json-boundary";
import { saveCommunicationEventToRuntimeDb } from "./runtime-db";
import { buildOutputRefForExecution } from "./session";
import { resolveWorkflowManagerStepId } from "./types";
import type { WorkflowJson, LoadOptions } from "./types";
import type {
  WorkflowSessionState,
  CommunicationRecord,
  NodeExecutionRecord,
  OutputRef,
} from "./session";
import { ok, err, type Result } from "./engine-types";
import {
  nextCommunicationId,
  initialDeliveryAttemptId,
  outputArtifactJsonText,
  WORKFLOW_EXTERNAL_INPUT_NODE_ID,
  WORKFLOW_EXTERNAL_OUTPUT_NODE_ID,
} from "./engine-utils";

interface CreateCommunicationInput {
  readonly artifactWorkflowRoot: string;
  readonly runtimeLogOptions?: LoadOptions;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly communicationCounter: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly routingScope: CommunicationRecord["routingScope"];
  readonly deliveryKind: CommunicationRecord["deliveryKind"];
  readonly transitionWhen: string;
  readonly sourceNodeExecId: string;
  readonly payloadRef: OutputRef;
  readonly outputRaw: string;
  readonly deliveredByNodeId: string;
  readonly createdAt: string;
}

export async function persistCommunicationArtifact(
  input: CreateCommunicationInput,
): Promise<CommunicationRecord> {
  const communicationId = nextCommunicationId(input.communicationCounter + 1);
  const deliveryAttemptId = initialDeliveryAttemptId();
  const communicationDir = path.join(
    input.artifactWorkflowRoot,
    "executions",
    input.workflowExecutionId,
    "communications",
    communicationId,
  );
  const envelope = {
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    communicationId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    routingScope: input.routingScope,
    sourceNodeExecId: input.sourceNodeExecId,
    deliveryKind: input.deliveryKind,
    payloadRef: {
      ...input.payloadRef,
      outputFile: "output.json",
    },
    createdAt: input.createdAt,
  };
  const meta = {
    status: "delivered",
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    communicationId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    sourceNodeExecId: input.sourceNodeExecId,
    routingScope: input.routingScope,
    deliveryKind: input.deliveryKind,
    activeDeliveryAttemptId: deliveryAttemptId,
    deliveryAttemptIds: [deliveryAttemptId],
    createdAt: input.createdAt,
    deliveredAt: input.createdAt,
  };
  const attempt = {
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    communicationId,
    deliveryAttemptId,
    toNodeId: input.toNodeId,
    status: "succeeded",
    startedAt: input.createdAt,
    endedAt: input.createdAt,
  };
  const receipt = {
    communicationId,
    deliveryAttemptId,
    deliveredByNodeId: input.deliveredByNodeId,
    deliveredAt: input.createdAt,
  };

  await mkdir(path.join(communicationDir, "outbox", input.fromNodeId), {
    recursive: true,
  });
  await mkdir(path.join(communicationDir, "inbox", input.toNodeId), {
    recursive: true,
  });
  await mkdir(path.join(communicationDir, "attempts", deliveryAttemptId), {
    recursive: true,
  });

  await writeJsonFile(path.join(communicationDir, "message.json"), envelope);
  await writeJsonFile(
    path.join(communicationDir, "outbox", input.fromNodeId, "message.json"),
    envelope,
  );
  await writeRawTextFile(
    path.join(communicationDir, "outbox", input.fromNodeId, "output.json"),
    input.outputRaw,
  );
  await writeJsonFile(
    path.join(communicationDir, "inbox", input.toNodeId, "message.json"),
    envelope,
  );
  await writeJsonFile(
    path.join(communicationDir, "attempts", deliveryAttemptId, "attempt.json"),
    attempt,
  );
  await writeJsonFile(
    path.join(communicationDir, "attempts", deliveryAttemptId, "receipt.json"),
    receipt,
  );
  await writeJsonFile(path.join(communicationDir, "meta.json"), meta);

  const communication: CommunicationRecord = {
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    communicationId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    routingScope: input.routingScope,
    sourceNodeExecId: input.sourceNodeExecId,
    payloadRef: input.payloadRef,
    deliveryKind: input.deliveryKind,
    transitionWhen: input.transitionWhen,
    status: "delivered",
    activeDeliveryAttemptId: deliveryAttemptId,
    deliveryAttemptIds: [deliveryAttemptId],
    createdAt: input.createdAt,
    deliveredAt: input.createdAt,
    artifactDir: communicationDir,
  };

  if (input.runtimeLogOptions !== undefined) {
    try {
      await saveCommunicationEventToRuntimeDb(
        communication,
        input.runtimeLogOptions,
      );
    } catch {
      // runtime DB event logs are best-effort
    }
  }

  return communication;
}

export function buildCommitMessageTemplate(
  inputHash: string,
  outputHash: string,
  ref: OutputRef,
  nextNodes: readonly string[],
): string {
  const summary = `chore(workflow): checkpoint node ${ref.outputNodeId}`;
  const nextNodeValue =
    nextNodes.length === 0 ? "(terminal)" : nextNodes.join(",");
  return [
    summary,
    "",
    "Node execution checkpoint for deterministic output-to-input handoff.",
    "",
    `Node-ID: ${ref.outputNodeId}`,
    `Run-ID: ${ref.workflowExecutionId}`,
    `Workflow-ID: ${ref.workflowId}`,
    `Node-Exec-ID: ${ref.nodeExecId}`,
    `Artifact-Dir: ${ref.artifactDir}`,
    `Input-Hash: sha256:${inputHash}`,
    `Output-Hash: sha256:${outputHash}`,
    `Next-Node: ${nextNodeValue}`,
  ].join("\n");
}

export async function persistExternalMailboxInputCommunication(input: {
  readonly artifactWorkflowRoot: string;
  readonly runtimeLogOptions?: LoadOptions;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly communicationCounter: number;
  readonly deliveredByNodeId: string;
  readonly toNodeId: string;
  readonly humanInput: unknown;
  readonly createdAt: string;
}): Promise<CommunicationRecord> {
  const sourceNodeExecId = "external-input-000001";
  const externalArtifactDir = path.join(
    input.artifactWorkflowRoot,
    "executions",
    input.workflowExecutionId,
    "external-mailbox",
    "input",
  );
  const outputPayload = {
    provider: "external-mailbox",
    model: "workflow-input",
    promptText: "workflow input mailbox delivery",
    completionPassed: true,
    when: { always: true },
    payload: normalizeExternalMailboxBusinessPayload(input.humanInput),
  };
  const outputRaw = outputArtifactJsonText(outputPayload);
  await mkdir(externalArtifactDir, { recursive: true });
  await writeRawTextFile(
    path.join(externalArtifactDir, "output.json"),
    outputRaw,
  );

  return persistCommunicationArtifact({
    artifactWorkflowRoot: input.artifactWorkflowRoot,
    ...(input.runtimeLogOptions === undefined
      ? {}
      : { runtimeLogOptions: input.runtimeLogOptions }),
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    communicationCounter: input.communicationCounter,
    fromNodeId: WORKFLOW_EXTERNAL_INPUT_NODE_ID,
    toNodeId: input.toNodeId,
    routingScope: "external-mailbox",
    deliveryKind: "external-input",
    transitionWhen: "external-mailbox:workflow-input",
    sourceNodeExecId,
    payloadRef: {
      kind: "node-output",
      workflowExecutionId: input.workflowExecutionId,
      workflowId: input.workflowId,
      outputNodeId: WORKFLOW_EXTERNAL_INPUT_NODE_ID,
      nodeExecId: sourceNodeExecId,
      artifactDir: externalArtifactDir,
    },
    outputRaw,
    deliveredByNodeId: input.deliveredByNodeId,
    createdAt: input.createdAt,
  });
}

export async function persistExternalMailboxOutputCommunication(input: {
  readonly artifactWorkflowRoot: string;
  readonly runtimeLogOptions?: LoadOptions;
  readonly workflow: WorkflowJson;
  readonly session: WorkflowSessionState;
  readonly execution: NodeExecutionRecord;
  readonly outputRaw: string;
  readonly communicationCounter: number;
  readonly createdAt: string;
}): Promise<CommunicationRecord> {
  return persistCommunicationArtifact({
    artifactWorkflowRoot: input.artifactWorkflowRoot,
    ...(input.runtimeLogOptions === undefined
      ? {}
      : { runtimeLogOptions: input.runtimeLogOptions }),
    workflowId: input.workflow.workflowId,
    workflowExecutionId: input.session.sessionId,
    communicationCounter: input.communicationCounter,
    fromNodeId: input.execution.nodeId,
    toNodeId: WORKFLOW_EXTERNAL_OUTPUT_NODE_ID,
    routingScope: "external-mailbox",
    deliveryKind: "external-output",
    transitionWhen: "external-mailbox:workflow-output",
    sourceNodeExecId: input.execution.nodeExecId,
    payloadRef: buildOutputRefForExecution({
      workflow: input.workflow,
      session: input.session,
      execution: input.execution,
    }),
    outputRaw: input.outputRaw,
    deliveredByNodeId: resolveWorkflowManagerStepId(input.workflow),
    createdAt: input.createdAt,
  });
}

export async function markCommunicationsConsumed(
  session: WorkflowSessionState,
  communicationIds: readonly string[],
  consumedByNodeExecId: string,
  consumedAt: string,
): Promise<Result<readonly CommunicationRecord[], string>> {
  if (communicationIds.length === 0) {
    return ok(session.communications);
  }

  const consumedSet = new Set(communicationIds);
  const updates: CommunicationRecord[] = [];
  for (const communication of session.communications) {
    if (!consumedSet.has(communication.communicationId)) {
      updates.push(communication);
      continue;
    }

    const activeAttemptId =
      communication.activeDeliveryAttemptId ??
      communication.deliveryAttemptIds[
        communication.deliveryAttemptIds.length - 1
      ] ??
      initialDeliveryAttemptId();
    const metaPath = path.join(communication.artifactDir, "meta.json");
    const receiptPath = path.join(
      communication.artifactDir,
      "attempts",
      activeAttemptId,
      "receipt.json",
    );

    let parsedMeta: Record<string, unknown>;
    let parsedReceipt: Record<string, unknown>;
    try {
      parsedMeta = JSON.parse(await readFile(metaPath, "utf8")) as Record<
        string,
        unknown
      >;
      parsedReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      return err(
        `failed to load mailbox delivery metadata for '${communication.communicationId}': ${message}`,
      );
    }

    try {
      await writeJsonFile(receiptPath, {
        ...parsedReceipt,
        consumedByNodeExecId,
        consumedAt,
      });
      await writeJsonFile(metaPath, {
        ...parsedMeta,
        status: "consumed",
        consumedByNodeExecId,
        consumedAt,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      return err(
        `failed to persist mailbox consumption for '${communication.communicationId}': ${message}`,
      );
    }

    updates.push({
      ...communication,
      status: "consumed",
      consumedByNodeExecId,
      consumedAt,
    });
  }

  return ok(updates);
}
