import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  AdapterExecutionError,
  ScenarioNodeAdapter,
  type AdapterExecutionInput,
  type AdapterExecutionOutput,
  type AdapterFailureCode,
  type MockNodeScenario,
  type NodeAdapter,
} from "./adapter";
import { DispatchingNodeAdapter } from "./adapters/dispatch";
import { loadWorkflowFromDisk } from "./load";
import { assembleNodeInput } from "./input-assembly";
import { err, ok, type Result } from "./result";
import { saveNodeExecutionToRuntimeDb } from "./runtime-db";
import { executeConversationRound } from "./conversation";
import { evaluateBranch, evaluateCompletion, resolveLoopTransition } from "./semantics";
import { planRootManagerSubWorkflowStarts, planSubWorkflowChildInputs } from "./sub-workflow";
import {
  createSessionId,
  createSessionState,
  type CommunicationRecord,
  type NodeExecutionRecord,
  type OutputRef,
  type WorkflowSessionState,
} from "./session";
import { loadSession, saveSession, type SessionStoreOptions } from "./session-store";
import type { LoadOptions, LoopRule, NodePayload, SubWorkflowRef, WorkflowEdge, WorkflowJson } from "./types";

export interface WorkflowRunOptions extends LoadOptions, SessionStoreOptions {
  readonly sessionId?: string;
  readonly runtimeVariables?: Readonly<Record<string, unknown>>;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly dryRun?: boolean;
  readonly mockScenario?: MockNodeScenario;
  readonly resumeSessionId?: string;
  readonly rerunFromSessionId?: string;
  readonly rerunFromNodeId?: string;
  readonly restartOnStuck?: boolean;
  readonly maxStuckRestarts?: number;
  readonly stuckRestartBackoffMs?: number;
}

export interface WorkflowRunResult {
  readonly session: WorkflowSessionState;
  readonly exitCode: number;
}

export interface WorkflowRunFailure {
  readonly exitCode: number;
  readonly message: string;
}

export interface CancellationProbe {
  isCancelled(sessionId: string): Promise<boolean>;
}

export interface EngineExecutionGuards {
  readonly cancellationProbe: CancellationProbe;
}

function mergeVariables(
  nodeVariables: Readonly<Record<string, unknown>>,
  runtimeVariables: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { ...nodeVariables, ...runtimeVariables };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface UpstreamOutputRef extends OutputRef {
  readonly fromNodeId: string;
  readonly transitionWhen: string;
  readonly status: NodeExecutionRecord["status"];
  readonly communicationId: string;
}

interface UpstreamInput extends UpstreamOutputRef {
  readonly output: Readonly<Record<string, unknown>>;
}

function nextNodeExecId(counter: number): string {
  return `exec-${String(counter).padStart(6, "0")}`;
}

function nextCommunicationId(counter: number): string {
  return `comm-${String(counter).padStart(6, "0")}`;
}

function initialDeliveryAttemptId(): string {
  return "attempt-000001";
}

function resolveTimeoutMs(
  node: NodePayload,
  workflowTimeoutMs: number,
  overrideTimeoutMs: number | undefined,
): number {
  if (node.timeoutMs !== undefined) {
    return node.timeoutMs;
  }
  if (overrideTimeoutMs !== undefined && overrideTimeoutMs > 0) {
    return overrideTimeoutMs;
  }
  return workflowTimeoutMs;
}

function evaluateEdge(edge: WorkflowEdge, output: Readonly<Record<string, unknown>>): boolean {
  return evaluateBranch({ when: edge.when, output });
}

async function executeAdapterWithTimeout(
  adapter: NodeAdapter,
  input: AdapterExecutionInput,
  timeoutMs: number,
): Promise<Result<AdapterExecutionOutput, AdapterFailureCode>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AdapterExecutionError("timeout", "adapter execution timed out"));
    }, timeoutMs);
  });

  try {
    const output = await Promise.race([
      adapter.execute(input, {
        timeoutMs,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return ok(output);
  } catch (error: unknown) {
    if (error instanceof AdapterExecutionError) {
      return err(error.code);
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return err("timeout");
    }
    return err("provider_error");
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function stableJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readOutputPayloadArtifact(artifactDir: string): Promise<Result<Readonly<Record<string, unknown>>, string>> {
  const outputPath = path.join(artifactDir, "output.json");

  try {
    const outputRaw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(outputRaw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return err(`output artifact '${outputPath}' must contain a JSON object`);
    }
    return ok(parsed as Readonly<Record<string, unknown>>);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    return err(`unable to read output artifact '${outputPath}': ${message}`);
  }
}

function outputRefForExecution(
  workflow: WorkflowJson,
  session: WorkflowSessionState,
  execution: NodeExecutionRecord,
  nodeId: string,
): OutputRef {
  const owningSubWorkflow = workflow.subWorkflows.find((entry) => {
    if (entry.nodeIds?.includes(nodeId) ?? false) {
      return true;
    }
    return entry.managerNodeId === nodeId || entry.inputNodeId === nodeId || entry.outputNodeId === nodeId;
  });
  return {
    workflowExecutionId: session.sessionId,
    workflowId: session.workflowId,
    ...(owningSubWorkflow === undefined ? {} : { subWorkflowId: owningSubWorkflow.id }),
    outputNodeId: nodeId,
    nodeExecId: execution.nodeExecId,
    artifactDir: execution.artifactDir,
  };
}

function isManagerNodeKind(kind: WorkflowJson["nodes"][number]["kind"]): boolean {
  return kind === "manager" || kind === "root-manager" || kind === "sub-manager";
}

function findOwningSubWorkflowByInputNodeId(workflow: WorkflowJson, nodeId: string): SubWorkflowRef | undefined {
  return workflow.subWorkflows.find((entry) => entry.inputNodeId === nodeId);
}

function buildUpstreamOutputRefs(
  workflow: WorkflowJson,
  session: WorkflowSessionState,
  nodeId: string,
): readonly UpstreamOutputRef[] {
  const owningSubWorkflow = findOwningSubWorkflowByInputNodeId(workflow, nodeId);
  const matchingCommunications = session.communications.filter((communication) => {
    if (communication.status !== "delivered") {
      return false;
    }
    if (communication.toNodeId === nodeId) {
      return true;
    }
    if (owningSubWorkflow === undefined) {
      return false;
    }
    return (
      communication.toSubWorkflowId === owningSubWorkflow.id &&
      communication.toNodeId === (owningSubWorkflow.managerNodeId ?? workflow.managerNodeId)
    );
  });
  if (matchingCommunications.length === 0) {
    return [];
  }

  return matchingCommunications
    .map((communication) => {
      const execution = session.nodeExecutions.find((candidate) => candidate.nodeExecId === communication.sourceNodeExecId);
      if (execution === undefined) {
        return undefined;
      }

      return {
        fromNodeId: communication.fromNodeId,
        transitionWhen: communication.transitionWhen,
        status: execution.status,
        communicationId: communication.communicationId,
        ...communication.payloadRef,
      };
    })
    .filter((entry): entry is UpstreamOutputRef => entry !== undefined);
}

async function buildUpstreamInputs(
  workflow: WorkflowJson,
  session: WorkflowSessionState,
  nodeId: string,
): Promise<Result<readonly UpstreamInput[], string>> {
  const refs = buildUpstreamOutputRefs(workflow, session, nodeId);
  if (refs.length === 0) {
    return ok([]);
  }

  const loaded: UpstreamInput[] = [];
  for (const ref of refs) {
    const output = await readOutputPayloadArtifact(ref.artifactDir);
    if (!output.ok) {
      return err(
        `failed to resolve upstream communication '${ref.communicationId}' for node '${nodeId}': ${output.error}`,
      );
    }
    loaded.push({
      ...ref,
      output: output.value,
    });
  }

  return ok(loaded);
}

function buildCommitMessageTemplate(inputHash: string, outputHash: string, ref: OutputRef, nextNodes: readonly string[]): string {
  const summary = `chore(workflow): checkpoint node ${ref.outputNodeId}`;
  const nextNodeValue = nextNodes.length === 0 ? "(terminal)" : nextNodes.join(",");
  return [
    summary,
    "",
    "Node execution checkpoint for deterministic output-to-input handoff.",
    "",
    `Node-ID: ${ref.outputNodeId}`,
    `Subworkflow-ID: ${ref.subWorkflowId ?? "(unset)"}`,
    `Run-ID: ${ref.workflowExecutionId}`,
    `Workflow-ID: ${ref.workflowId}`,
    `Node-Exec-ID: ${ref.nodeExecId}`,
    `Artifact-Dir: ${ref.artifactDir}`,
    `Input-Hash: sha256:${inputHash}`,
    `Output-Hash: sha256:${outputHash}`,
    `Next-Node: ${nextNodeValue}`,
  ].join("\n");
}

interface CreateCommunicationInput {
  readonly artifactWorkflowRoot: string;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly communicationCounter: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly fromSubWorkflowId?: string;
  readonly toSubWorkflowId?: string;
  readonly routingScope: CommunicationRecord["routingScope"];
  readonly deliveryKind: CommunicationRecord["deliveryKind"];
  readonly transitionWhen: string;
  readonly sourceNodeExecId: string;
  readonly payloadRef: OutputRef;
  readonly outputPayload: Readonly<Record<string, unknown>>;
  readonly deliveredByNodeId: string;
  readonly createdAt: string;
}

async function persistCommunicationArtifact(input: CreateCommunicationInput): Promise<CommunicationRecord> {
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
    ...(input.fromSubWorkflowId === undefined ? {} : { fromSubWorkflowId: input.fromSubWorkflowId }),
    ...(input.toSubWorkflowId === undefined ? {} : { toSubWorkflowId: input.toSubWorkflowId }),
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
    ...(input.fromSubWorkflowId === undefined ? {} : { fromSubWorkflowId: input.fromSubWorkflowId }),
    ...(input.toSubWorkflowId === undefined ? {} : { toSubWorkflowId: input.toSubWorkflowId }),
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

  await mkdir(path.join(communicationDir, "outbox", input.fromNodeId), { recursive: true });
  await mkdir(path.join(communicationDir, "inbox", input.toNodeId), { recursive: true });
  await mkdir(path.join(communicationDir, "attempts", deliveryAttemptId), { recursive: true });

  await writeJsonFile(path.join(communicationDir, "message.json"), envelope);
  await writeJsonFile(path.join(communicationDir, "outbox", input.fromNodeId, "message.json"), envelope);
  await writeJsonFile(path.join(communicationDir, "outbox", input.fromNodeId, "output.json"), input.outputPayload);
  await writeJsonFile(path.join(communicationDir, "inbox", input.toNodeId, "message.json"), envelope);
  await writeJsonFile(path.join(communicationDir, "attempts", deliveryAttemptId, "attempt.json"), attempt);
  await writeJsonFile(path.join(communicationDir, "attempts", deliveryAttemptId, "receipt.json"), receipt);
  await writeJsonFile(path.join(communicationDir, "meta.json"), meta);

  return {
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    communicationId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    ...(input.fromSubWorkflowId === undefined ? {} : { fromSubWorkflowId: input.fromSubWorkflowId }),
    ...(input.toSubWorkflowId === undefined ? {} : { toSubWorkflowId: input.toSubWorkflowId }),
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
}

async function markCommunicationsConsumed(
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
      communication.deliveryAttemptIds[communication.deliveryAttemptIds.length - 1] ??
      initialDeliveryAttemptId();
    const metaPath = path.join(communication.artifactDir, "meta.json");
    const receiptPath = path.join(communication.artifactDir, "attempts", activeAttemptId, "receipt.json");

    let parsedMeta: Record<string, unknown>;
    let parsedReceipt: Record<string, unknown>;
    try {
      parsedMeta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      parsedReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      return err(`failed to load mailbox delivery metadata for '${communication.communicationId}': ${message}`);
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
      return err(`failed to persist mailbox consumption for '${communication.communicationId}': ${message}`);
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

function isTerminalStatus(status: WorkflowSessionState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function cloneSession(session: WorkflowSessionState): WorkflowSessionState {
  return {
    ...session,
    queue: [...session.queue],
    nodeExecutionCounts: { ...session.nodeExecutionCounts },
    loopIterationCounts: { ...(session.loopIterationCounts ?? {}) },
    restartCounts: { ...(session.restartCounts ?? {}) },
    restartEvents: [...(session.restartEvents ?? [])],
    transitions: [...session.transitions],
    nodeExecutions: [...session.nodeExecutions],
    communicationCounter: session.communicationCounter,
    communications: [...session.communications],
    conversationTurns: [...(session.conversationTurns ?? [])],
    runtimeVariables: { ...session.runtimeVariables },
  };
}

export async function runWorkflow(
  workflowName: string,
  options: WorkflowRunOptions = {},
  adapter?: NodeAdapter,
  guards?: EngineExecutionGuards,
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> {
  const loaded = await loadWorkflowFromDisk(workflowName, options);
  if (!loaded.ok) {
    return err({
      exitCode: loaded.error.code === "VALIDATION" || loaded.error.code === "INVALID_WORKFLOW_NAME" ? 2 : 1,
      message: loaded.error.message,
    });
  }

  const runtimeVariables = options.runtimeVariables ?? {};
  const workflow = loaded.value.bundle.workflow;
  const nodeMap = loaded.value.bundle.nodePayloads;
  const workflowNodes = new Map(workflow.nodes.map((entry) => [entry.id, entry]));
  const loopRuleByJudgeNodeId = new Map<string, LoopRule>((workflow.loops ?? []).map((entry) => [entry.judgeNodeId, entry]));
  const effectiveAdapter =
    adapter ??
    (options.mockScenario === undefined ? new DispatchingNodeAdapter() : new ScenarioNodeAdapter(options.mockScenario));
  const cancellationProbe =
    guards?.cancellationProbe ??
    ({
      async isCancelled(sessionId: string): Promise<boolean> {
        const current = await loadSession(sessionId, options);
        return current.ok && current.value.status === "cancelled";
      },
    } satisfies CancellationProbe);

  let session: WorkflowSessionState;
  if (options.rerunFromSessionId !== undefined) {
    if (options.rerunFromNodeId === undefined) {
      return err({ exitCode: 1, message: "rerunFromNodeId is required when rerunFromSessionId is set" });
    }
    if (!workflowNodes.has(options.rerunFromNodeId)) {
      return err({ exitCode: 1, message: `unknown rerun node '${options.rerunFromNodeId}'` });
    }

    const source = await loadSession(options.rerunFromSessionId, options);
    if (!source.ok) {
      return err({ exitCode: 1, message: source.error.message });
    }
    if (source.value.workflowName !== workflowName) {
      return err({ exitCode: 1, message: "source session workflow does not match command workflow" });
    }

    session = createSessionState({
      sessionId: createSessionId(),
      workflowName,
      workflowId: workflow.workflowId,
      initialNodeId: options.rerunFromNodeId,
      runtimeVariables: { ...source.value.runtimeVariables, ...runtimeVariables },
    });
  } else if (options.resumeSessionId !== undefined) {
    const existing = await loadSession(options.resumeSessionId, options);
    if (!existing.ok) {
      return err({ exitCode: 1, message: existing.error.message });
    }
    if (existing.value.workflowName !== workflowName) {
      return err({ exitCode: 1, message: "session workflow does not match command workflow" });
    }
    session = cloneSession(existing.value);
    if (session.status === "completed") {
      return ok({ session, exitCode: 0 });
    }
    session = {
      ...session,
      status: "running",
      runtimeVariables: { ...session.runtimeVariables, ...runtimeVariables },
    };
  } else {
    session = createSessionState({
      sessionId: options.sessionId ?? createSessionId(),
      workflowName,
      workflowId: workflow.workflowId,
      initialNodeId: workflow.managerNodeId,
      runtimeVariables,
    });
  }

  await saveSession(session, options);

  const outgoingEdges = new Map<string, WorkflowEdge[]>();
  workflow.edges.forEach((edge) => {
    const current = outgoingEdges.get(edge.from);
    if (current) {
      current.push(edge);
      return;
    }
    outgoingEdges.set(edge.from, [edge]);
  });

  const maxLoopIterations = options.maxLoopIterations ?? workflow.defaults.maxLoopIterations;
  const maxSteps = options.maxSteps;
  const restartOnStuck = options.restartOnStuck ?? true;
  const maxStuckRestarts = options.maxStuckRestarts ?? 2;
  const stuckRestartBackoffMs = options.stuckRestartBackoffMs ?? 250;

  while (session.queue.length > 0) {
    const persisted = await loadSession(session.sessionId, options);
    if (persisted.ok && isTerminalStatus(persisted.value.status)) {
      if (persisted.value.status === "completed") {
        return ok({ session: persisted.value, exitCode: 0 });
      }
      const exitCode = persisted.value.status === "cancelled" ? 130 : 1;
      return err({ exitCode, message: persisted.value.lastError ?? `session ${persisted.value.status}` });
    }
    if (await cancellationProbe.isCancelled(session.sessionId)) {
      const cancelled: WorkflowSessionState = {
        ...session,
        status: "cancelled",
        ...(session.queue[0] === undefined ? {} : { currentNodeId: session.queue[0] }),
        endedAt: nowIso(),
        lastError: "cancelled by external request",
      };
      await saveSession(cancelled, options);
      return err({ exitCode: 130, message: cancelled.lastError ?? "cancelled" });
    }

    if (maxSteps !== undefined && session.nodeExecutionCounter >= maxSteps) {
      const paused: WorkflowSessionState = {
        ...session,
        status: "paused",
        ...(session.queue[0] === undefined ? {} : { currentNodeId: session.queue[0] }),
        endedAt: nowIso(),
        lastError: `max steps reached (${maxSteps})`,
      };
      await saveSession(paused, options);
      return ok({ session: paused, exitCode: 4 });
    }

    const queue = [...session.queue];
    const nodeId = queue.shift();
    if (nodeId === undefined) {
      break;
    }

    const nodeRef = workflowNodes.get(nodeId);
    const nodePayload = nodeMap[nodeId];
    if (!nodeRef || !nodePayload) {
      const failed: WorkflowSessionState = {
        ...session,
        queue,
        status: "failed",
        currentNodeId: nodeId,
        endedAt: nowIso(),
        lastError: `missing node definition for '${nodeId}'`,
      };
      await saveSession(failed, options);
      return err({ exitCode: 1, message: failed.lastError ?? "missing node definition" });
    }

    let restartAttempt = 0;
    let previousNodeExecId: string | undefined;

    for (;;) {
      const nextCount = (session.nodeExecutionCounts[nodeId] ?? 0) + 1;
      const updatedCounts = { ...session.nodeExecutionCounts, [nodeId]: nextCount };
      const loopRule = loopRuleByJudgeNodeId.get(nodeId);

      const nextExecutionCounter = session.nodeExecutionCounter + 1;
      const nodeExecId = nextNodeExecId(nextExecutionCounter);
      const workflowExecutionRoot = path.join(loaded.value.artifactWorkflowRoot, "executions", session.sessionId);
      const artifactDir = path.join(workflowExecutionRoot, "nodes", nodeId, nodeExecId);
      await mkdir(artifactDir, { recursive: true });

      const mergedVariables = mergeVariables(nodePayload.variables, session.runtimeVariables);
      const upstreamOutputRefs = buildUpstreamOutputRefs(workflow, session, nodeId);
      const upstreamInputsResult = await buildUpstreamInputs(workflow, session, nodeId);
      if (!upstreamInputsResult.ok) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: upstreamInputsResult.error,
        };
        await saveSession(failed, options);
        return err({ exitCode: 1, message: failed.lastError ?? "upstream communication resolution failed" });
      }
      const upstreamInputs = upstreamInputsResult.value;
      const upstreamBindingInputs = upstreamInputs.map((entry) => ({
        fromNodeId: entry.fromNodeId,
        transitionWhen: entry.transitionWhen,
        status: entry.status,
        communicationId: entry.communicationId,
        output: entry.output,
      }));
      const upstreamCommunicationIds = upstreamInputs.map((entry) => entry.communicationId);
      const transcriptInput = (session.conversationTurns ?? []).map((turn) => ({
        conversationId: turn.conversationId,
        turnIndex: turn.turnIndex,
        fromSubWorkflowId: turn.fromSubWorkflowId,
        toSubWorkflowId: turn.toSubWorkflowId,
        outputRef: turn.outputRef,
        sentAt: turn.sentAt,
      }));

      let assembledPromptText: string;
      let assembledArguments: Readonly<Record<string, unknown>> | null;
      try {
        const assembled = assembleNodeInput({
          runtimeVariables: session.runtimeVariables,
          node: nodePayload,
          upstream: upstreamBindingInputs,
          transcript: transcriptInput,
        });
        assembledPromptText = assembled.promptText;
        assembledArguments = assembled.arguments;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "unknown input assembly failure";
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: `input assembly failed at '${nodeId}': ${message}`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 3, message: failed.lastError ?? "input assembly failed" });
      }

      const inputPayload = {
        sessionId: session.sessionId,
        workflowId: workflow.workflowId,
        nodeId,
        nodeExecId,
        model: nodePayload.model,
        promptTemplate: nodePayload.promptTemplate,
        promptText: assembledPromptText,
        arguments: assembledArguments,
        variables: mergedVariables,
        upstreamOutputRefs,
        upstreamCommunications: upstreamCommunicationIds,
        restartAttempt,
        ...(previousNodeExecId === undefined ? {} : { restartedFromNodeExecId: previousNodeExecId }),
        dryRun: options.dryRun ?? false,
      };
      const inputJson = stableJson(inputPayload);
      await writeFile(path.join(artifactDir, "input.json"), `${inputJson}\n`, "utf8");

      const startedAt = nowIso();
      const timeoutMs = resolveTimeoutMs(nodePayload, workflow.defaults.nodeTimeoutMs, options.defaultTimeoutMs);

      let outputPayload: Readonly<Record<string, unknown>>;
      let nodeStatus: NodeExecutionRecord["status"] = "succeeded";

      if (options.dryRun === true) {
        outputPayload = {
          provider: "dry-run",
          model: nodePayload.model,
          promptText: assembledPromptText,
          completionPassed: true,
          when: { always: true },
          payload: { skippedExecution: true },
        };
      } else {
        const execution = await executeAdapterWithTimeout(
          effectiveAdapter,
          {
            workflowId: workflow.workflowId,
            nodeId,
            node: nodePayload,
            mergedVariables,
            promptText: assembledPromptText,
            arguments: assembledArguments,
            executionIndex: nextCount,
          },
          timeoutMs,
        );

        if (!execution.ok) {
          nodeStatus = execution.error === "timeout" ? "timed_out" : "failed";
          outputPayload = {
            provider: "deterministic-local",
            model: nodePayload.model,
            completionPassed: false,
            when: {},
            payload: {},
            error: execution.error,
          };
        } else {
          outputPayload = {
            provider: execution.value.provider,
            model: execution.value.model,
            promptText: execution.value.promptText,
            completionPassed: execution.value.completionPassed,
            when: execution.value.when,
            payload: execution.value.payload,
          };
        }
      }

      const endedAt = nowIso();
      const edges = outgoingEdges.get(nodeId) ?? [];
      const matched = edges.filter((edge) => evaluateEdge(edge, outputPayload));
      const loopIterationCounts = session.loopIterationCounts ?? {};
      let selected = matched;
      let updatedLoopIterationCounts = loopIterationCounts;
      if (loopRule !== undefined) {
        const effectiveLoopRule: LoopRule = {
          ...loopRule,
          maxIterations: loopRule.maxIterations ?? maxLoopIterations,
        };
        const iteration = loopIterationCounts[loopRule.id] ?? 0;
        const transition = resolveLoopTransition({
          loopRule: effectiveLoopRule,
          output: outputPayload,
          state: { loopId: loopRule.id, iteration },
        });
        if (transition === "continue") {
          selected = edges.filter((edge) => edge.when === effectiveLoopRule.continueWhen);
          updatedLoopIterationCounts = {
            ...loopIterationCounts,
            [loopRule.id]: iteration + 1,
          };
        } else if (transition === "exit") {
          selected = edges.filter((edge) => edge.when === effectiveLoopRule.exitWhen);
        } else {
          selected = matched.filter(
            (edge) => edge.when !== effectiveLoopRule.continueWhen && edge.when !== effectiveLoopRule.exitWhen,
          );
        }

        if (selected.length === 0 && transition !== "none") {
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions: [
              ...session.nodeExecutions,
              {
                nodeId,
                nodeExecId,
                status: nodeStatus,
                artifactDir,
                startedAt,
                endedAt,
                ...(restartAttempt === 0 ? {} : { attempt: restartAttempt + 1 }),
                ...(previousNodeExecId === undefined ? {} : { restartedFromNodeExecId: previousNodeExecId }),
              },
            ],
            loopIterationCounts: updatedLoopIterationCounts,
            lastError: `loop transition '${transition}' has no matching edge at '${nodeId}'`,
          };
          await saveSession(failed, options);
          return err({ exitCode: 4, message: failed.lastError ?? "invalid loop transition" });
        }
      }
      const nextNodes = selected.map((edge) => edge.to);

      const outputJson = stableJson(outputPayload);
      const metaPayload = {
        nodeId,
        nodeExecId,
        status: nodeStatus,
        startedAt,
        endedAt,
        model: nodePayload.model,
        timeoutMs,
        restartAttempt,
        ...(previousNodeExecId === undefined ? {} : { restartedFromNodeExecId: previousNodeExecId }),
      };
      const outputRef = outputRefForExecution(
        workflow,
        { ...session, workflowId: workflow.workflowId },
        {
          nodeId,
          nodeExecId,
          status: nodeStatus,
          artifactDir,
          startedAt,
          endedAt,
        },
        nodeId,
      );
      const inputHash = sha256Hex(inputJson);
      const outputHash = sha256Hex(outputJson);
      let currentCommunications: readonly CommunicationRecord[] = session.communications;
      let currentCommunicationCounter = session.communicationCounter;

      const handoffPayload = {
        schemaVersion: 1,
        generatedAt: endedAt,
        nodeId,
        outputRef,
        inputHash: `sha256:${inputHash}`,
        outputHash: `sha256:${outputHash}`,
        nextNodes,
      };
      const commitMessageTemplate = buildCommitMessageTemplate(inputHash, outputHash, outputRef, nextNodes);

      await writeFile(path.join(artifactDir, "output.json"), `${outputJson}\n`, "utf8");
      await writeJsonFile(path.join(artifactDir, "meta.json"), metaPayload);
      await writeJsonFile(path.join(artifactDir, "handoff.json"), handoffPayload);
      await writeFile(path.join(artifactDir, "commit-message.txt"), `${commitMessageTemplate}\n`, "utf8");

      try {
        await saveNodeExecutionToRuntimeDb(
          {
            sessionId: session.sessionId,
            nodeId,
            nodeExecId,
            status: nodeStatus,
            artifactDir,
            startedAt,
            endedAt,
            ...(restartAttempt === 0 ? {} : { attempt: restartAttempt + 1 }),
            ...(previousNodeExecId === undefined ? {} : { restartedFromNodeExecId: previousNodeExecId }),
            inputJson,
            outputJson,
            inputHash: `sha256:${inputHash}`,
            outputHash: `sha256:${outputHash}`,
          },
          options,
        );
      } catch {
        // runtime DB index is best-effort and must not break artifact/session persistence
      }

      const nodeExecutions = [
        ...session.nodeExecutions,
        {
          nodeId,
          nodeExecId,
          status: nodeStatus,
          artifactDir,
          startedAt,
          endedAt,
          ...(restartAttempt === 0 ? {} : { attempt: restartAttempt + 1 }),
          ...(previousNodeExecId === undefined ? {} : { restartedFromNodeExecId: previousNodeExecId }),
        },
      ];

      if (nodeStatus === "timed_out") {
        if (restartOnStuck && restartAttempt < maxStuckRestarts) {
          const restartCountForNode = (session.restartCounts?.[nodeId] ?? 0) + 1;
          const restartEvents = [
            ...(session.restartEvents ?? []),
            {
              nodeId,
              fromNodeExecId: nodeExecId,
              restartAttempt: restartAttempt + 1,
              reason: "stuck_timeout" as const,
              at: endedAt,
            },
          ];

          session = {
            ...session,
            status: "running",
            queue,
            currentNodeId: nodeId,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            restartCounts: { ...(session.restartCounts ?? {}), [nodeId]: restartCountForNode },
            restartEvents,
            nodeExecutions,
            communicationCounter: currentCommunicationCounter,
            communications: currentCommunications,
            lastError: `stuck detected at '${nodeId}', restarting attempt ${restartAttempt + 1}`,
          };
          await saveSession(session, options);

          previousNodeExecId = nodeExecId;
          restartAttempt += 1;
          if (stuckRestartBackoffMs > 0) {
            await sleep(stuckRestartBackoffMs);
          }
          continue;
        }

        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          nodeExecutions,
          communicationCounter: currentCommunicationCounter,
          communications: currentCommunications,
          lastError: `node timeout at '${nodeId}'`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 6, message: failed.lastError ?? "node timeout" });
      }

      if (nodeStatus === "failed") {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          nodeExecutions,
          communicationCounter: currentCommunicationCounter,
          communications: currentCommunications,
          lastError: `adapter failure at '${nodeId}'`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 5, message: failed.lastError ?? "adapter failure" });
      }

      const completion = evaluateCompletion({
        rule: nodeRef.completion,
        output: outputPayload,
      });
      if (!completion.passed) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          nodeExecutions,
          loopIterationCounts: updatedLoopIterationCounts,
          communicationCounter: currentCommunicationCounter,
          communications: currentCommunications,
          lastError:
            completion.reason === null
              ? `completion condition not met at '${nodeId}'`
              : `completion condition not met at '${nodeId}': ${completion.reason}`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 3, message: failed.lastError ?? "completion condition not met" });
      }
      const consumedCommunicationsResult = await markCommunicationsConsumed(
        { ...session, communications: currentCommunications },
        upstreamCommunicationIds,
        nodeExecId,
        endedAt,
      );
      if (!consumedCommunicationsResult.ok) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          nodeExecutions,
          loopIterationCounts: updatedLoopIterationCounts,
          communicationCounter: currentCommunicationCounter,
          communications: currentCommunications,
          lastError: consumedCommunicationsResult.error,
        };
        await saveSession(failed, options);
        return err({ exitCode: 1, message: failed.lastError ?? "mailbox consumption persistence failed" });
      }
      currentCommunications = consumedCommunicationsResult.value;
      const transitionCommunications = await Promise.all(
        selected.map((edge, index) =>
          persistCommunicationArtifact({
            artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
            workflowId: workflow.workflowId,
            workflowExecutionId: session.sessionId,
            communicationCounter: currentCommunicationCounter + index,
            fromNodeId: edge.from,
            toNodeId: edge.to,
            routingScope: "intra-sub-workflow",
            deliveryKind: edge.to === edge.from ? "loop-back" : "edge-transition",
            transitionWhen: edge.when,
            sourceNodeExecId: nodeExecId,
            payloadRef: outputRef,
            outputPayload,
            deliveredByNodeId: workflow.managerNodeId,
            createdAt: endedAt,
          }),
        ),
      );
      currentCommunications = [...currentCommunications, ...transitionCommunications];
      currentCommunicationCounter += transitionCommunications.length;

      const transitions = [
        ...session.transitions,
        ...selected.map((edge) => ({ from: edge.from, to: edge.to, when: edge.when })),
      ];
      const transitionNextNodes = selected.map((edge) => edge.to);
      let managerPlannedInputs = isManagerNodeKind(nodeRef.kind)
        ? nodeRef.kind === "sub-manager"
          ? [...planSubWorkflowChildInputs({
              workflow,
              session: {
                ...session,
                nodeExecutions,
              },
              managerNodeId: nodeId,
            })]
          : []
        : [];

      let managerPlannedCommunications: readonly CommunicationRecord[] = [];
      if (nodeId === workflow.managerNodeId) {
        const plannedSubWorkflowStarts = planRootManagerSubWorkflowStarts({
          workflow,
          session: {
            ...session,
            nodeExecutions,
          },
        });
        const persistedStarts: CommunicationRecord[] = [];
        for (const subWorkflow of plannedSubWorkflowStarts) {
          if (subWorkflow.managerNodeId === undefined || subWorkflow.managerNodeId === workflow.managerNodeId) {
            managerPlannedInputs.push(subWorkflow.inputNodeId);
            continue;
          }
          const communication = await persistCommunicationArtifact({
            artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
            workflowId: workflow.workflowId,
            workflowExecutionId: session.sessionId,
            communicationCounter: currentCommunicationCounter,
            fromNodeId: nodeId,
            toNodeId: subWorkflow.managerNodeId,
            toSubWorkflowId: subWorkflow.id,
            routingScope: "parent-to-sub-workflow",
            deliveryKind: "edge-transition",
            transitionWhen: `sub-workflow-start:${subWorkflow.id}`,
            sourceNodeExecId: nodeExecId,
            payloadRef: outputRef,
            outputPayload,
            deliveredByNodeId: nodeId,
            createdAt: endedAt,
          });
          currentCommunicationCounter += 1;
          persistedStarts.push(communication);
          managerPlannedInputs.push(subWorkflow.managerNodeId);
        }
        managerPlannedCommunications = persistedStarts;
      } else if (nodeRef.kind === "sub-manager") {
        const forwardedPayloads = upstreamInputs.length === 0
          ? [{ payloadRef: outputRef, outputPayload }]
          : upstreamInputs.map((entry) => ({
              payloadRef: {
                workflowExecutionId: entry.workflowExecutionId,
                workflowId: entry.workflowId,
                ...(entry.subWorkflowId === undefined ? {} : { subWorkflowId: entry.subWorkflowId }),
                outputNodeId: entry.outputNodeId,
                nodeExecId: entry.nodeExecId,
                artifactDir: entry.artifactDir,
              },
              outputPayload: entry.output,
            }));
        const persistedChildInputs: CommunicationRecord[] = [];
        for (const inputNodeId of managerPlannedInputs) {
          for (const forwarded of forwardedPayloads) {
            const communication = await persistCommunicationArtifact({
              artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
              workflowId: workflow.workflowId,
              workflowExecutionId: session.sessionId,
              communicationCounter: currentCommunicationCounter,
              fromNodeId: nodeId,
              toNodeId: inputNodeId,
              routingScope: "intra-sub-workflow",
              deliveryKind: "edge-transition",
              transitionWhen: `sub-manager-input:${inputNodeId}`,
              sourceNodeExecId: forwarded.payloadRef.nodeExecId,
              payloadRef: forwarded.payloadRef,
              outputPayload: forwarded.outputPayload,
              deliveredByNodeId: nodeId,
              createdAt: endedAt,
            });
            currentCommunicationCounter += 1;
            persistedChildInputs.push(communication);
          }
        }
        managerPlannedCommunications = persistedChildInputs;
      }
      currentCommunications = [...currentCommunications, ...managerPlannedCommunications];

      let conversationTurns = [...(session.conversationTurns ?? [])];
      let conversationPlannedInputs: string[] = [];
      if (isManagerNodeKind(nodeRef.kind)) {
        const conversationRound = await executeConversationRound({
          workflow,
          workflowExecutionId: session.sessionId,
          session: {
            ...session,
            nodeExecutions,
            conversationTurns,
            communicationCounter: currentCommunicationCounter,
            communications: currentCommunications,
          },
        });

        if (conversationRound.status === "failed") {
          const failed: WorkflowSessionState = {
            ...session,
            queue,
            status: "failed",
            currentNodeId: nodeId,
            endedAt,
            nodeExecutionCounter: nextExecutionCounter,
            nodeExecutionCounts: updatedCounts,
            nodeExecutions,
            loopIterationCounts: updatedLoopIterationCounts,
            communicationCounter: currentCommunicationCounter,
            communications: currentCommunications,
            conversationTurns,
            lastError: "conversation round execution failed",
          };
          await saveSession(failed, options);
          return err({ exitCode: 1, message: failed.lastError ?? "conversation round execution failed" });
        }

        if (conversationRound.turns.length > 0) {
          const successfulTurnDeliveries: Array<{
            readonly turn: (typeof conversationRound.turns)[number];
            readonly communication: CommunicationRecord;
            readonly receiverManagerNodeId: string;
          }> = [];
          for (const turn of conversationRound.turns) {
            if (turn.toManagerNodeId === undefined) {
              continue;
            }
            const parsedOutput = await readOutputPayloadArtifact(turn.outputRef.artifactDir);
            if (!parsedOutput.ok) {
              const failed: WorkflowSessionState = {
                ...session,
                queue,
                status: "failed",
                currentNodeId: nodeId,
                endedAt,
                nodeExecutionCounter: nextExecutionCounter,
                nodeExecutionCounts: updatedCounts,
                nodeExecutions,
                loopIterationCounts: updatedLoopIterationCounts,
                communicationCounter: currentCommunicationCounter,
                communications: currentCommunications,
                conversationTurns,
                lastError:
                  `failed to resolve conversation output for '${turn.fromSubWorkflowId}' -> '${turn.toSubWorkflowId}': ` +
                  parsedOutput.error,
              };
              await saveSession(failed, options);
              return err({ exitCode: 1, message: failed.lastError ?? "conversation output resolution failed" });
            }
            const communication = await persistCommunicationArtifact({
              artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
              workflowId: workflow.workflowId,
              workflowExecutionId: session.sessionId,
              communicationCounter: currentCommunicationCounter,
              fromNodeId: turn.fromManagerNodeId,
              toNodeId: turn.toManagerNodeId,
              fromSubWorkflowId: turn.fromSubWorkflowId,
              toSubWorkflowId: turn.toSubWorkflowId,
              routingScope: "cross-sub-workflow",
              deliveryKind: "conversation-turn",
              transitionWhen: `conversation:${turn.conversationId}:${turn.turnIndex}`,
              sourceNodeExecId: turn.outputRef.nodeExecId,
              payloadRef: turn.outputRef,
              outputPayload: parsedOutput.value,
              deliveredByNodeId: workflow.managerNodeId,
              createdAt: endedAt,
            });
            currentCommunicationCounter += 1;
            successfulTurnDeliveries.push({ turn, communication, receiverManagerNodeId: turn.toManagerNodeId });
          }
          currentCommunications = [...currentCommunications, ...successfulTurnDeliveries.map((entry) => entry.communication)];
          conversationTurns = [
            ...conversationTurns,
            ...successfulTurnDeliveries.map((entry) => ({
              ...entry.turn,
              communicationId: entry.communication.communicationId,
              sentAt: endedAt,
            })),
          ];
          conversationPlannedInputs = successfulTurnDeliveries.map((entry) => entry.receiverManagerNodeId);
        }
      }

      const nextQueue = [...queue, ...transitionNextNodes, ...managerPlannedInputs, ...conversationPlannedInputs].filter(
        (value, index, all) => all.indexOf(value) === index,
      );

      session = {
        ...session,
        status: "running",
        queue: nextQueue,
        currentNodeId: nodeId,
        nodeExecutionCounter: nextExecutionCounter,
        nodeExecutionCounts: updatedCounts,
        loopIterationCounts: updatedLoopIterationCounts,
        transitions,
        nodeExecutions,
        communicationCounter: currentCommunicationCounter,
        communications: currentCommunications,
        conversationTurns,
      };

      await saveSession(session, options);
      break;
    }
  }

  const beforeComplete = await loadSession(session.sessionId, options);
  if (beforeComplete.ok && isTerminalStatus(beforeComplete.value.status)) {
    if (beforeComplete.value.status === "completed") {
      return ok({ session: beforeComplete.value, exitCode: 0 });
    }
    const exitCode = beforeComplete.value.status === "cancelled" ? 130 : 1;
    return err({ exitCode, message: beforeComplete.value.lastError ?? `session ${beforeComplete.value.status}` });
  }

  const completed: WorkflowSessionState = {
    ...session,
    status: "completed",
    endedAt: nowIso(),
    queue: [],
  };

  await saveSession(completed, options);
  return ok({ session: completed, exitCode: 0 });
}
