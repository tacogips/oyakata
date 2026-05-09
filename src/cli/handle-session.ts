import { loadSession } from "../workflow/session-store";
import { runWorkflow } from "../workflow/engine";
import { listRuntimeNodeLogs } from "../workflow/runtime-db";
import {
  continueWorkflowFromHistory,
  listMergedWorkflowExecutionStepRuns,
} from "../lib";
import {
  emitJson,
  buildStepProgressSummaries,
  resolveSessionCurrentStepId,
  serializeRuntimeNodeLogs,
  printHelp,
} from "./helpers";
import {
  executeCliGraphqlOperation,
  buildRemoteExecutionInput,
  buildLocalWorkflowRunOverrides,
  buildWorkflowExecutionExport,
  rejectUnsupportedRemoteMockScenario,
} from "./graphql-remote";
import {
  readMockScenarioOption,
  writeExportFile,
  writeTextFile,
} from "./io-helpers";
import { parseStepRunExecutionStatusFilter } from "./arg-parser";
import type { CliHandlerContext } from "./types";

export async function handleSessionScope(
  ctx: CliHandlerContext,
): Promise<number> {
  const {
    io,
    parsed,
    command,
    target,
    positionals,
    sharedOptions,
    graphqlCliTransport,
  } = ctx;

  if (target === undefined) {
    io.stderr("session id is required");
    printHelp(io);
    return 2;
  }

  if (command === "progress") {
    const session = await loadSession(target, sharedOptions);
    if (!session.ok) {
      io.stderr(session.error.message);
      return 1;
    }

    const countsByNode = session.value.nodeExecutionCounts;
    const currentStepId = await resolveSessionCurrentStepId(
      session.value,
      sharedOptions,
    );
    const stepSummaries = buildStepProgressSummaries(session.value);
    const nodeSummaries = Object.keys(countsByNode)
      .sort((a, b) => a.localeCompare(b))
      .map((nodeId) => ({
        nodeId,
        executions: countsByNode[nodeId] ?? 0,
        restarts: session.value.restartCounts?.[nodeId] ?? 0,
      }));

    if (parsed.options.output === "json") {
      emitJson(io, {
        sessionId: session.value.sessionId,
        workflowName: session.value.workflowName,
        status: session.value.status,
        queue: session.value.queue,
        currentNodeId: session.value.currentNodeId ?? null,
        currentStepId,
        totalExecutions: session.value.nodeExecutionCounter,
        nodeSummaries,
        stepSummaries,
        lastError: session.value.lastError ?? null,
      });
    } else {
      io.stdout(`sessionId: ${session.value.sessionId}`);
      io.stdout(`workflow: ${session.value.workflowName}`);
      io.stdout(`status: ${session.value.status}`);
      io.stdout(`currentNodeId: ${session.value.currentNodeId ?? "-"}`);
      if (currentStepId !== null) {
        io.stdout(`currentStepId: ${currentStepId}`);
      }
      io.stdout(`queue: ${session.value.queue.join(",") || "-"}`);
      io.stdout(`totalExecutions: ${session.value.nodeExecutionCounter}`);
      io.stdout("nodeProgress:");
      nodeSummaries.forEach((summary) => {
        io.stdout(
          `  - ${summary.nodeId}: executions=${summary.executions}, restarts=${summary.restarts}`,
        );
      });
      if (stepSummaries.length > 0) {
        io.stdout("stepProgress:");
        stepSummaries.forEach((summary) => {
          io.stdout(
            `  - ${summary.stepId}: executions=${summary.executions}, restarts=${summary.restarts}`,
          );
        });
      }
    }
    return 0;
  }

  if (command === "status") {
    const session = await loadSession(target, sharedOptions);
    if (!session.ok) {
      io.stderr(session.error.message);
      return 1;
    }

    const currentStepId = await resolveSessionCurrentStepId(
      session.value,
      sharedOptions,
    );
    if (parsed.options.output === "json") {
      emitJson(io, {
        ...session.value,
        currentStepId,
      });
    } else {
      io.stdout(`sessionId: ${session.value.sessionId}`);
      io.stdout(`workflow: ${session.value.workflowName}`);
      io.stdout(`status: ${session.value.status}`);
      io.stdout(`currentNodeId: ${session.value.currentNodeId ?? "-"}`);
      if (currentStepId !== null) {
        io.stdout(`currentStepId: ${currentStepId}`);
      }
      io.stdout(`queueLength: ${session.value.queue.length}`);
    }
    return 0;
  }

  if (command === "resume") {
    if (graphqlCliTransport !== null) {
      if (rejectUnsupportedRemoteMockScenario(parsed.options, io)) {
        return 2;
      }
      try {
        const data = await executeCliGraphqlOperation({
          transport: graphqlCliTransport,
          document: `
              mutation ResumeWorkflowExecution($input: ResumeWorkflowExecutionInput!) {
                resumeWorkflowExecution(input: $input) {
                  workflowExecutionId
                  sessionId
                  status
                  exitCode
                }
              }
            `,
          variables: {
            input: {
              workflowExecutionId: target,
              ...buildRemoteExecutionInput(parsed.options),
            },
          },
        });
        const payload = data["resumeWorkflowExecution"] as Record<
          string,
          unknown
        >;
        const sessionId = payload["sessionId"] as string;
        const status = payload["status"] as string;
        const exitCode = payload["exitCode"] as number;

        if (parsed.options.output === "json") {
          emitJson(io, {
            sessionId,
            status,
            exitCode,
          });
        } else {
          io.stdout(`session resumed: ${sessionId}`);
          io.stdout(`status: ${status}`);
        }
        return exitCode;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        io.stderr(`remote resume failed: ${message}`);
        return 1;
      }
    }
    const session = await loadSession(target, sharedOptions);
    if (!session.ok) {
      io.stderr(session.error.message);
      return 1;
    }

    let mockScenarioOptions: Readonly<{
      mockScenario?: import("../workflow/adapter").MockNodeScenario;
    }> = {};
    try {
      mockScenarioOptions = await readMockScenarioOption(
        parsed.options.mockScenarioPath,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to read --mock-scenario file: ${message}`);
      return 1;
    }

    const result = await runWorkflow(session.value.workflowName, {
      ...sharedOptions,
      ...buildLocalWorkflowRunOverrides(parsed.options),
      resumeSessionId: session.value.sessionId,
      ...mockScenarioOptions,
    });

    if (!result.ok) {
      io.stderr(result.error.message);
      return result.error.exitCode;
    }

    if (parsed.options.output === "json") {
      emitJson(io, {
        sessionId: result.value.session.sessionId,
        status: result.value.session.status,
        exitCode: result.value.exitCode,
      });
    } else {
      io.stdout(`session resumed: ${result.value.session.sessionId}`);
      io.stdout(`status: ${result.value.session.status}`);
    }
    return result.value.exitCode;
  }

  if (command === "continue") {
    const startStepRaw = parsed.options.continuationStartStepId;
    const afterRunRaw = parsed.options.continuationAfterStepRunId;
    const startStep = startStepRaw?.trim() ?? "";
    const afterRun = afterRunRaw?.trim() ?? "";
    let missingUsage = false;
    if (startStep.length === 0) {
      io.stderr("--start-step is required for session continue");
      missingUsage = true;
    }
    if (afterRun.length === 0) {
      io.stderr("--after-step-run is required for session continue");
      missingUsage = true;
    }
    if (missingUsage) {
      io.stderr(
        "usage: divedra session continue <workflow-execution-id> --start-step <step-id> --after-step-run <step-run-id> [options]",
      );
      return 2;
    }
    if (parsed.options.nestedSuperviser) {
      io.stderr(
        "--nested-supervisor / --nested-superviser is not supported for session continue",
      );
      return 2;
    }
    if (parsed.options.autoImprove !== undefined) {
      io.stderr("--auto-improve cannot be combined with session continue");
      return 2;
    }
    if (graphqlCliTransport !== null) {
      io.stderr(
        "session continue currently supports local execution only; omit --endpoint",
      );
      return 2;
    }

    let mockScenarioOptions: Readonly<{
      mockScenario?: import("../workflow/adapter").MockNodeScenario;
    }> = {};
    try {
      mockScenarioOptions = await readMockScenarioOption(
        parsed.options.mockScenarioPath,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to read --mock-scenario file: ${message}`);
      return 1;
    }

    try {
      const {
        autoImprove: _omitA,
        nestedSuperviserDriver: _omitN,
        ...budgetOverrides
      } = buildLocalWorkflowRunOverrides(parsed.options);

      const result = await continueWorkflowFromHistory({
        ...sharedOptions,
        ...budgetOverrides,
        sourceWorkflowExecutionId: target,
        afterStepRunId: afterRun,
        startStepId: startStep,
        ...mockScenarioOptions,
      });

      if (parsed.options.output === "json") {
        emitJson(io, {
          sourceWorkflowExecutionId: target,
          sessionId: result.sessionId,
          status: result.status,
          continuedAfterStepRunId: result.continuedAfterStepRunId,
          continuedStartStepId: result.continuedStartStepId,
          exitCode: result.exitCode,
        });
      } else {
        io.stdout(`sourceWorkflowExecutionId: ${target}`);
        io.stdout(`continued session: ${result.sessionId}`);
        io.stdout(`continuedAfterStepRunId: ${result.continuedAfterStepRunId}`);
        io.stdout(`continuedStartStepId: ${result.continuedStartStepId}`);
        io.stdout(`status: ${result.status}`);
      }
      return result.exitCode;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`session continue failed: ${message}`);
      return 1;
    }
  }

  if (command === "rerun") {
    const fromStepId = positionals[3];
    if (fromStepId === undefined) {
      io.stderr("step id is required for session rerun");
      io.stderr(
        "usage: divedra session rerun <session-id> <step-id> [options]",
      );
      return 2;
    }
    if (parsed.options.nestedSuperviser) {
      io.stderr(
        "--nested-supervisor / --nested-superviser is not supported for session rerun; use workflow run or session resume with --auto-improve instead",
      );
      return 2;
    }
    if (graphqlCliTransport !== null) {
      if (rejectUnsupportedRemoteMockScenario(parsed.options, io)) {
        return 2;
      }
      try {
        const data = await executeCliGraphqlOperation({
          transport: graphqlCliTransport,
          document: `
              mutation RerunWorkflowExecution($input: RerunWorkflowExecutionInput!) {
                rerunWorkflowExecution(input: $input) {
                  workflowExecutionId
                  sessionId
                  status
                  exitCode
                }
              }
            `,
          variables: {
            input: {
              workflowExecutionId: target,
              stepId: fromStepId,
              ...buildRemoteExecutionInput(parsed.options),
            },
          },
        });
        const payload = data["rerunWorkflowExecution"] as Record<
          string,
          unknown
        >;
        const sessionId = payload["sessionId"] as string;
        const status = payload["status"] as string;
        const exitCode = payload["exitCode"] as number;

        if (parsed.options.output === "json") {
          emitJson(io, {
            sourceSessionId: target,
            sessionId,
            status,
            rerunFromStepId: fromStepId,
            exitCode,
          });
        } else {
          io.stdout(`sourceSessionId: ${target}`);
          io.stdout(`rerun session: ${sessionId}`);
          io.stdout(`rerunFromStepId: ${fromStepId}`);
          io.stdout(`status: ${status}`);
        }
        return exitCode;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        io.stderr(`remote rerun failed: ${message}`);
        return 1;
      }
    }

    const source = await loadSession(target, sharedOptions);
    if (!source.ok) {
      io.stderr(source.error.message);
      return 1;
    }

    let mockScenarioOptions: Readonly<{
      mockScenario?: import("../workflow/adapter").MockNodeScenario;
    }> = {};
    try {
      mockScenarioOptions = await readMockScenarioOption(
        parsed.options.mockScenarioPath,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to read --mock-scenario file: ${message}`);
      return 1;
    }

    const result = await runWorkflow(source.value.workflowName, {
      ...sharedOptions,
      ...buildLocalWorkflowRunOverrides(parsed.options),
      rerunFromSessionId: source.value.sessionId,
      rerunFromStepId: fromStepId,
      ...mockScenarioOptions,
    });

    if (!result.ok) {
      io.stderr(result.error.message);
      return result.error.exitCode;
    }

    if (parsed.options.output === "json") {
      emitJson(io, {
        sourceSessionId: source.value.sessionId,
        sessionId: result.value.session.sessionId,
        status: result.value.session.status,
        rerunFromStepId: fromStepId,
        exitCode: result.value.exitCode,
      });
    } else {
      io.stdout(`sourceSessionId: ${source.value.sessionId}`);
      io.stdout(`rerun session: ${result.value.session.sessionId}`);
      io.stdout(`rerunFromStepId: ${fromStepId}`);
      io.stdout(`status: ${result.value.session.status}`);
    }
    return result.value.exitCode;
  }

  if (command === "step-runs") {
    if (graphqlCliTransport !== null) {
      io.stderr(
        "session step-runs currently supports local execution only; omit --endpoint",
      );
      return 2;
    }

    const statusParsed = parseStepRunExecutionStatusFilter(
      parsed.options.status,
    );
    if (!statusParsed.ok) {
      io.stderr(statusParsed.error);
      return 2;
    }

    const filterStepCandidate = parsed.options.stepRunsFilterStepId?.trim();
    const filterStepId =
      filterStepCandidate !== undefined && filterStepCandidate.length > 0
        ? filterStepCandidate
        : undefined;

    try {
      const overview = await listMergedWorkflowExecutionStepRuns({
        ...sharedOptions,
        workflowExecutionId: target,
        ...(filterStepId === undefined ? {} : { filterStepId }),
        ...(statusParsed.value === undefined
          ? {}
          : { filterStatus: statusParsed.value }),
      });

      if (parsed.options.output === "json") {
        emitJson(io, overview);
      } else {
        io.stdout(`workflowExecutionId: ${overview.workflowExecutionId}`);
        io.stdout(`workflow: ${overview.workflowName}`);
        if (overview.stepRuns.length === 0) {
          io.stdout("stepRuns: (none matching filters)");
        } else {
          io.stdout("stepRuns:");
          for (const row of overview.stepRuns) {
            io.stdout(
              `  timeline=${String(row.timelineOrdinal)} ord=${String(row.executionOrdinal)} stepRunId=${row.stepRunId} stepId=${row.stepId ?? "-"} owner=${row.persistedWorkflowExecutionId} status=${row.status} imported=${row.imported ? "yes" : "no"} started=${row.startedAt} ended=${row.endedAt}`,
            );
          }
        }
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`session step-runs failed: ${message}`);
      return 1;
    }
  }

  if (command === "export") {
    if (graphqlCliTransport !== null) {
      io.stderr(
        "session export currently supports local execution only; omit --endpoint",
      );
      return 2;
    }

    let payload: import("./types").WorkflowExecutionExport;
    try {
      payload = await buildWorkflowExecutionExport(target, sharedOptions);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`session export failed: ${message}`);
      return 1;
    }

    if (parsed.options.filePath === undefined) {
      emitJson(io, payload);
      return 0;
    }

    try {
      const savedPath = await writeExportFile(parsed.options.filePath, payload);
      if (parsed.options.output === "json") {
        emitJson(io, {
          filePath: savedPath,
          workflowId: payload.workflowId,
          workflowExecutionId: payload.workflowExecutionId,
          workflowName: payload.workflowName,
          status: payload.status,
        });
      } else {
        io.stdout(`exported workflow run to ${savedPath}`);
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to write session export file: ${message}`);
      return 1;
    }
  }

  if (command === "logs") {
    if (graphqlCliTransport !== null) {
      io.stderr(
        "session logs currently supports local execution only; omit --endpoint",
      );
      return 2;
    }
    const session = await loadSession(target, sharedOptions);
    if (!session.ok) {
      io.stderr(session.error.message);
      return 1;
    }

    const logs = await listRuntimeNodeLogs(target, sharedOptions);
    const formatBase = parsed.options.format ?? parsed.options.output;
    const format = formatBase === "table" ? "text" : formatBase;
    const serialized = serializeRuntimeNodeLogs(logs, format);

    if (parsed.options.filePath !== undefined) {
      try {
        const savedPath = await writeTextFile(
          parsed.options.filePath,
          serialized,
        );
        if (parsed.options.output === "json") {
          emitJson(io, {
            filePath: savedPath,
            sessionId: target,
            workflowId: session.value.workflowId,
            workflowName: session.value.workflowName,
            logCount: logs.length,
            format,
          });
        } else {
          io.stdout(`exported session logs to ${savedPath}`);
        }
        return 0;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        io.stderr(`failed to write session logs file: ${message}`);
        return 1;
      }
    }

    if (format === "json") {
      emitJson(io, logs);
    } else {
      for (const line of serialized
        .trimEnd()
        .split("\n")
        .filter((l) => l.length > 0)) {
        io.stdout(line);
      }
    }
    return 0;
  }

  io.stderr(`unknown session command: ${command}`);
  printHelp(io);
  return 1;
}
