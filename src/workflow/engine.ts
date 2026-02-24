import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  AdapterExecutionError,
  DeterministicNodeAdapter,
  ScenarioNodeAdapter,
  type AdapterExecutionInput,
  type AdapterExecutionOutput,
  type AdapterFailureCode,
  type MockNodeScenario,
  type NodeAdapter,
} from "./adapter";
import { loadWorkflowFromDisk } from "./load";
import { assembleNodeInput } from "./input-assembly";
import { err, ok, type Result } from "./result";
import { saveNodeExecutionToRuntimeDb } from "./runtime-db";
import { evaluateBranch, evaluateCompletion, resolveLoopTransition } from "./semantics";
import { planManagerSubWorkflowInputs } from "./sub-workflow";
import {
  createSessionId,
  createSessionState,
  type NodeExecutionRecord,
  type WorkflowSessionState,
} from "./session";
import { loadSession, saveSession, type SessionStoreOptions } from "./session-store";
import type { LoadOptions, LoopRule, NodePayload, WorkflowEdge } from "./types";

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

interface UpstreamInput extends UpstreamOutputRef {
  readonly output: Readonly<Record<string, unknown>>;
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

async function buildUpstreamInputs(
  session: WorkflowSessionState,
  nodeId: string,
): Promise<readonly UpstreamInput[]> {
  const refs = buildUpstreamOutputRefs(session, nodeId);
  if (refs.length === 0) {
    return [];
  }

  const loaded = await Promise.all(
    refs.map(async (ref) => {
      try {
        const outputRaw = await readFile(path.join(ref.artifactDir, "output.json"), "utf8");
        const parsed = JSON.parse(outputRaw) as unknown;
        if (typeof parsed !== "object" || parsed === null) {
          return null;
        }
        return {
          ...ref,
          output: parsed as Readonly<Record<string, unknown>>,
        };
      } catch {
        return null;
      }
    }),
  );

  return loaded.filter((entry): entry is UpstreamInput => entry !== null);
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
    adapter ?? (options.mockScenario === undefined ? new DeterministicNodeAdapter() : new ScenarioNodeAdapter(options.mockScenario));
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
      if (loopRule === undefined && nextCount > maxLoopIterations) {
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
      const upstreamOutputRefs = buildUpstreamOutputRefs(session, nodeId);
      const upstreamInputs = await buildUpstreamInputs(session, nodeId);
      const upstreamBindingInputs = upstreamInputs.map((entry) => ({
        fromNodeId: entry.fromNodeId,
        transitionWhen: entry.transitionWhen,
        status: entry.status,
        output: entry.output,
      }));

      let assembledPromptText: string;
      let assembledArguments: Readonly<Record<string, unknown>> | null;
      try {
        const assembled = assembleNodeInput({
          runtimeVariables: session.runtimeVariables,
          node: nodePayload,
          upstream: upstreamBindingInputs,
          transcript: [],
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
          lastError:
            completion.reason === null
              ? `completion condition not met at '${nodeId}'`
              : `completion condition not met at '${nodeId}': ${completion.reason}`,
        };
        await saveSession(failed, options);
        return err({ exitCode: 3, message: failed.lastError ?? "completion condition not met" });
      }

      const transitions = [
        ...session.transitions,
        ...selected.map((edge) => ({ from: edge.from, to: edge.to, when: edge.when })),
      ];
      const transitionNextNodes = selected.map((edge) => edge.to);
      const managerPlannedInputs =
        nodeRef.kind === "manager"
          ? planManagerSubWorkflowInputs({
              workflow,
              session: {
                ...session,
                nodeExecutions,
              },
            })
          : [];
      const nextQueue = [...queue, ...transitionNextNodes, ...managerPlannedInputs].filter(
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
