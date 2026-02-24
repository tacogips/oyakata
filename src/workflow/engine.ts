import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  DeterministicNodeAdapter,
  ScenarioNodeAdapter,
  type MockNodeScenario,
  type NodeAdapter,
} from "./adapter";
import { loadWorkflowFromDisk } from "./load";
import { err, ok, type Result } from "./result";
import { saveNodeExecutionToRuntimeDb } from "./runtime-db";
import {
  createSessionId,
  createSessionState,
  type NodeExecutionRecord,
  type WorkflowSessionState,
} from "./session";
import { loadSession, saveSession, type SessionStoreOptions } from "./session-store";
import { renderPromptTemplate } from "./render";
import type { LoadOptions, NodePayload, WorkflowEdge, WorkflowNodeRef } from "./types";

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

interface OutputRef {
  readonly sessionId: string;
  readonly workflowId: string;
  readonly outputNodeId: string;
  readonly nodeExecId: string;
  readonly artifactDir: string;
}

interface UpstreamOutputRef extends OutputRef {
  readonly fromNodeId: string;
  readonly transitionWhen: string;
  readonly status: NodeExecutionRecord["status"];
}

function nextNodeExecId(counter: number): string {
  return `exec-${String(counter).padStart(6, "0")}`;
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
  if (edge.when === "always") {
    return true;
  }

  const whenMap = output["when"];
  if (typeof whenMap === "object" && whenMap !== null) {
    const value = (whenMap as Record<string, unknown>)[edge.when];
    return value === true;
  }

  const direct = output[edge.when];
  return direct === true;
}

async function runWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<Result<T, "timed_out" | "failed">> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timed_out")), timeoutMs);
    });

    const result = await Promise.race([task, timeoutPromise]);
    return ok(result as T);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "timed_out") {
      return err("timed_out");
    }
    return err("failed");
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function stableJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function outputRefForExecution(
  session: WorkflowSessionState,
  execution: NodeExecutionRecord,
  nodeId: string,
): OutputRef {
  return {
    sessionId: session.sessionId,
    workflowId: session.workflowId,
    outputNodeId: nodeId,
    nodeExecId: execution.nodeExecId,
    artifactDir: execution.artifactDir,
  };
}

function buildUpstreamOutputRefs(
  session: WorkflowSessionState,
  nodeId: string,
): readonly UpstreamOutputRef[] {
  const matchingTransitions = session.transitions.filter((transition) => transition.to === nodeId);
  if (matchingTransitions.length === 0) {
    return [];
  }

  return matchingTransitions
    .map((transition) => {
      const execution = [...session.nodeExecutions]
        .reverse()
        .find((candidate) => candidate.nodeId === transition.from);
      if (execution === undefined) {
        return undefined;
      }
      return {
        fromNodeId: transition.from,
        transitionWhen: transition.when,
        status: execution.status,
        ...outputRefForExecution(session, execution, transition.from),
      };
    })
    .filter((entry): entry is UpstreamOutputRef => entry !== undefined);
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
    `Subworkflow-ID: (unset)`,
    `Run-ID: ${ref.sessionId}`,
    `Workflow-ID: ${ref.workflowId}`,
    `Node-Exec-ID: ${ref.nodeExecId}`,
    `Artifact-Dir: ${ref.artifactDir}`,
    `Input-Hash: sha256:${inputHash}`,
    `Output-Hash: sha256:${outputHash}`,
    `Next-Node: ${nextNodeValue}`,
  ].join("\n");
}

function completionSatisfied(node: WorkflowNodeRef, output: Readonly<Record<string, unknown>>): boolean {
  if (node.completion === undefined || node.completion.type === "none") {
    return true;
  }
  return output["completionPassed"] === true;
}

function cloneSession(session: WorkflowSessionState): WorkflowSessionState {
  return {
    ...session,
    queue: [...session.queue],
    nodeExecutionCounts: { ...session.nodeExecutionCounts },
    restartCounts: { ...(session.restartCounts ?? {}) },
    restartEvents: [...(session.restartEvents ?? [])],
    transitions: [...session.transitions],
    nodeExecutions: [...session.nodeExecutions],
    runtimeVariables: { ...session.runtimeVariables },
  };
}

export async function runWorkflow(
  workflowName: string,
  options: WorkflowRunOptions = {},
  adapter?: NodeAdapter,
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
  const effectiveAdapter =
    adapter ?? (options.mockScenario === undefined ? new DeterministicNodeAdapter() : new ScenarioNodeAdapter(options.mockScenario));

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
      if (nextCount > maxLoopIterations) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt: nowIso(),
          lastError: `loop budget exceeded for node '${nodeId}'`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 4, message: failed.lastError ?? "loop budget exceeded" });
      }

      const nextExecutionCounter = session.nodeExecutionCounter + 1;
      const nodeExecId = nextNodeExecId(nextExecutionCounter);
      const artifactDir = path.join(loaded.value.artifactWorkflowRoot, nodeId, nodeExecId);
      await mkdir(artifactDir, { recursive: true });

      const mergedVariables = mergeVariables(nodePayload.variables, session.runtimeVariables);
      const promptText = renderPromptTemplate(nodePayload.promptTemplate, mergedVariables);
      const upstreamOutputRefs = buildUpstreamOutputRefs(session, nodeId);

      const inputPayload = {
        sessionId: session.sessionId,
        workflowId: workflow.workflowId,
        nodeId,
        nodeExecId,
        model: nodePayload.model,
        promptTemplate: nodePayload.promptTemplate,
        promptText,
        variables: mergedVariables,
        upstreamOutputRefs,
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
          promptText,
          completionPassed: true,
          when: { always: true },
          payload: { skippedExecution: true },
        };
      } else {
        const execution = await runWithTimeout(
          effectiveAdapter.execute({
            workflowId: workflow.workflowId,
            nodeId,
            node: nodePayload,
            mergedVariables,
            executionIndex: nextCount,
          }),
          timeoutMs,
        );

        if (!execution.ok) {
          nodeStatus = execution.error === "timed_out" ? "timed_out" : "failed";
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
      const nextNodes = matched.map((edge) => edge.to);

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

      const updatedCounts = { ...session.nodeExecutionCounts, [nodeId]: nextCount };

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
          lastError: `adapter failure at '${nodeId}'`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 5, message: failed.lastError ?? "adapter failure" });
      }

      if (!completionSatisfied(nodeRef, outputPayload)) {
        const failed: WorkflowSessionState = {
          ...session,
          queue,
          status: "failed",
          currentNodeId: nodeId,
          endedAt,
          nodeExecutionCounter: nextExecutionCounter,
          nodeExecutionCounts: updatedCounts,
          nodeExecutions,
          lastError: `completion condition not met at '${nodeId}'`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 3, message: failed.lastError ?? "completion condition not met" });
      }

      const transitions = [
        ...session.transitions,
        ...matched.map((edge) => ({ from: edge.from, to: edge.to, when: edge.when })),
      ];
      const nextQueue = [...queue, ...matched.map((edge) => edge.to)];

      session = {
        ...session,
        status: "running",
        queue: nextQueue,
        currentNodeId: nodeId,
        nodeExecutionCounter: nextExecutionCounter,
        nodeExecutionCounts: updatedCounts,
        transitions,
        nodeExecutions,
      };

      await saveSession(session, options);
      break;
    }
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
