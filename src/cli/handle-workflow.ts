import { loadWorkflowFromCatalog } from "../workflow/load";
import { createWorkflowTemplate } from "../workflow/create";
import { runWorkflow } from "../workflow/engine";
import { buildInspectionSummary } from "../workflow/inspect";
import { collectWorkflowAddonSourceSummaries } from "../workflow/addon-source-summary";
import {
  buildWorkflowCatalogOverview,
  buildWorkflowStatusOverview,
  parseWorkflowOverviewAggregateStatusFilter,
} from "../workflow/overview";
import {
  emitJson,
  formatValidationIssues,
  formatWorkflowSource,
  workflowSourceJson,
  formatAddonSource,
  optionsForLoadedWorkflow,
  printHelp,
} from "./helpers";
import {
  executeCliGraphqlOperation,
  buildRemoteExecutionInput,
  fetchRemoteWorkflowRunSummary,
  buildLocalWorkflowRunOverrides,
  WORKFLOW_CATALOG_OVERVIEW_GQL,
  WORKFLOW_STATUS_OVERVIEW_GQL,
  workflowOverviewRowFromGraphqlJson,
  workflowStatusOverviewFromGraphqlJson,
  renderWorkflowOverviewTableLines,
  renderWorkflowStatusOverviewLines,
  workflowOverviewGraphqlVariables,
  rejectUnsupportedRemoteMockScenario,
} from "./graphql-remote";
import { readRuntimeVariables, readMockScenarioOption } from "./io-helpers";
import { requireObjectField, requireArrayField } from "./helpers";
import type { CliHandlerContext } from "./types";

export async function handleWorkflowScope(
  ctx: CliHandlerContext,
): Promise<number> {
  const { io, parsed, command, target, sharedOptions, graphqlCliTransport } =
    ctx;

  if (command === "list") {
    const statusParsed = parseWorkflowOverviewAggregateStatusFilter(
      parsed.options.status,
    );
    if (!statusParsed.ok) {
      io.stderr(statusParsed.error);
      return 2;
    }
    const statusFilter = statusParsed.value;
    if (graphqlCliTransport !== null) {
      try {
        const data = await executeCliGraphqlOperation({
          transport: graphqlCliTransport,
          document: WORKFLOW_CATALOG_OVERVIEW_GQL,
          variables: workflowOverviewGraphqlVariables(
            parsed.options,
            statusFilter,
          ),
        });
        const catalog = requireObjectField(
          data["workflowCatalogOverview"],
          "workflowCatalogOverview",
        );
        if (parsed.options.output === "json") {
          emitJson(io, catalog);
        } else {
          const rowsRaw = requireArrayField(catalog["workflows"], "workflows");
          const rows = rowsRaw.map((entry, index) =>
            workflowOverviewRowFromGraphqlJson(
              entry,
              `workflows[${String(index)}]`,
            ),
          );
          for (const line of renderWorkflowOverviewTableLines(rows)) {
            io.stdout(line);
          }
        }
        return 0;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        io.stderr(`remote workflow list failed: ${message}`);
        return 1;
      }
    }
    const built = await buildWorkflowCatalogOverview(
      {
        ...(parsed.options.workflowScope === undefined
          ? {}
          : { workflowScope: parsed.options.workflowScope }),
        ...(statusFilter === undefined ? {} : { status: statusFilter }),
        ...(parsed.options.limit === undefined
          ? {}
          : { limit: parsed.options.limit }),
      },
      sharedOptions,
    );
    if (!built.ok) {
      io.stderr(built.error.message);
      return 1;
    }
    if (parsed.options.output === "json") {
      emitJson(io, built.value);
    } else {
      for (const line of renderWorkflowOverviewTableLines(
        built.value.workflows,
      )) {
        io.stdout(line);
      }
    }
    return 0;
  }

  if (command === "status") {
    if (target === undefined) {
      io.stderr("workflow name is required for workflow status");
      printHelp(io);
      return 2;
    }
    const statusParsed = parseWorkflowOverviewAggregateStatusFilter(
      parsed.options.status,
    );
    if (!statusParsed.ok) {
      io.stderr(statusParsed.error);
      return 2;
    }
    if (statusParsed.value !== undefined) {
      io.stderr(
        "workflow status does not support filtering catalog rows by --status; omit --status",
      );
      return 2;
    }
    if (graphqlCliTransport !== null) {
      try {
        const variables: Record<string, unknown> = {
          workflowName: target,
          ...(parsed.options.workflowScope === undefined
            ? {}
            : { workflowScope: parsed.options.workflowScope }),
          ...(parsed.options.limit === undefined
            ? {}
            : { limit: parsed.options.limit }),
        };
        const data = await executeCliGraphqlOperation({
          transport: graphqlCliTransport,
          document: WORKFLOW_STATUS_OVERVIEW_GQL,
          variables,
        });
        const payload = data["workflowStatusOverview"];
        if (payload === null || payload === undefined) {
          io.stderr(
            `workflow '${target}' was not found for workflow status overview`,
          );
          return 2;
        }
        const overview = workflowStatusOverviewFromGraphqlJson(
          payload,
          "workflowStatusOverview",
        );
        if (parsed.options.output === "json") {
          emitJson(io, overview);
        } else {
          for (const line of renderWorkflowStatusOverviewLines(overview)) {
            io.stdout(line);
          }
        }
        return 0;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        io.stderr(`remote workflow status failed: ${message}`);
        return 1;
      }
    }
    const built = await buildWorkflowStatusOverview(
      {
        workflowName: target,
        ...(parsed.options.workflowScope === undefined
          ? {}
          : { workflowScope: parsed.options.workflowScope }),
        ...(parsed.options.limit === undefined
          ? {}
          : { limit: parsed.options.limit }),
      },
      sharedOptions,
    );
    if (!built.ok) {
      const code = built.error.code;
      if (
        code === "NOT_FOUND" ||
        code === "INVALID_WORKFLOW_NAME" ||
        code === "INVALID_SCOPE"
      ) {
        io.stderr(built.error.message);
        return 2;
      }
      io.stderr(built.error.message);
      return 1;
    }
    if (parsed.options.output === "json") {
      emitJson(io, built.value);
    } else {
      for (const line of renderWorkflowStatusOverviewLines(built.value)) {
        io.stdout(line);
      }
    }
    return 0;
  }

  if (target === undefined) {
    io.stderr("workflow name is required");
    printHelp(io);
    return 2;
  }

  if (command === "create") {
    const created = await createWorkflowTemplate(target, {
      ...sharedOptions,
      ...(parsed.options.workerOnly
        ? { templateMode: "worker-only" as const }
        : {}),
    });
    if (!created.ok) {
      io.stderr(created.error.message);
      return created.error.code === "INVALID_WORKFLOW_NAME" ||
        created.error.code === "INVALID_SCOPE"
        ? 2
        : 1;
    }
    if (parsed.options.output === "json") {
      emitJson(io, {
        workflowName: created.value.workflowName,
        workflowDirectory: created.value.workflowDirectory,
      });
    } else {
      io.stdout(`created workflow: ${created.value.workflowDirectory}`);
    }
    return 0;
  }

  if (command === "validate") {
    const loaded = await loadWorkflowFromCatalog(target, sharedOptions);
    if (!loaded.ok) {
      if (parsed.options.output === "json") {
        emitJson(io, loaded.error);
      } else {
        io.stderr(`validation failed: ${loaded.error.message}`);
        if (loaded.error.issues) {
          io.stderr(formatValidationIssues(loaded.error.issues));
        }
      }
      return loaded.error.code === "VALIDATION" ||
        loaded.error.code === "INVALID_WORKFLOW_NAME" ||
        loaded.error.code === "INVALID_SCOPE"
        ? 2
        : 1;
    }
    const loadedWorkflowOptions = optionsForLoadedWorkflow(
      loaded.value,
      sharedOptions,
    );
    const addonSources = await collectWorkflowAddonSourceSummaries({
      workflow: loaded.value.bundle.workflow,
      options: loadedWorkflowOptions,
      ...(loaded.value.source === undefined
        ? {}
        : { workflowSource: loaded.value.source }),
    });
    if (parsed.options.output === "json") {
      emitJson(io, {
        workflowName: loaded.value.workflowName,
        workflowId: loaded.value.bundle.workflow.workflowId,
        source: workflowSourceJson(loaded.value.source),
        addonSources,
        valid: true,
      });
    } else {
      io.stdout(`workflow '${loaded.value.workflowName}' is valid`);
      const sourceLine = formatWorkflowSource(loaded.value.source);
      if (sourceLine !== undefined) {
        io.stdout(`source: ${sourceLine}`);
      }
      for (const addonSource of addonSources) {
        io.stdout(`addonSource: ${formatAddonSource(addonSource)}`);
      }
    }
    return 0;
  }

  if (command === "inspect") {
    const loaded = await loadWorkflowFromCatalog(target, sharedOptions);
    if (!loaded.ok) {
      io.stderr(`inspect failed: ${loaded.error.message}`);
      if (loaded.error.issues) {
        io.stderr(formatValidationIssues(loaded.error.issues));
      }
      return loaded.error.code === "VALIDATION" ||
        loaded.error.code === "INVALID_WORKFLOW_NAME" ||
        loaded.error.code === "INVALID_SCOPE"
        ? 2
        : 1;
    }

    const loadedWorkflowOptions = optionsForLoadedWorkflow(
      loaded.value,
      sharedOptions,
    );
    const summary = await buildInspectionSummary(
      loaded.value,
      loadedWorkflowOptions,
    );
    if (parsed.options.output === "json") {
      emitJson(io, {
        ...summary,
        source: workflowSourceJson(loaded.value.source),
      });
    } else {
      io.stdout(`workflow: ${summary.workflowName}`);
      const sourceLine = formatWorkflowSource(loaded.value.source);
      if (sourceLine !== undefined) {
        io.stdout(`source: ${sourceLine}`);
      }
      for (const addonSource of summary.addonSources) {
        io.stdout(`addonSource: ${formatAddonSource(addonSource)}`);
      }
      io.stdout(`workflowId: ${summary.workflowId}`);
      io.stdout(
        `managerStepId: ${summary.managerStepId ?? "(implicit or worker-only)"}`,
      );
      io.stdout(
        `entryStepId: ${summary.entryStepId ?? "(not set; check workflow authorship)"}`,
      );
      io.stdout(`stepIds: ${summary.stepIds.join(", ")}`);
      io.stdout(`nodeRegistryIds: ${summary.nodeRegistryIds.join(", ")}`);
      io.stdout(
        `steps: ${summary.counts.steps}, nodeRegistry: ${summary.counts.nodeRegistry}, crossWorkflowDispatches: ${summary.counts.crossWorkflowDispatches}`,
      );
      if (summary.crossWorkflowDispatchIds.length > 0) {
        io.stdout(
          `crossWorkflowDispatchIds: ${summary.crossWorkflowDispatchIds.join(", ")}`,
        );
      }
      io.stdout(
        `defaults: maxLoopIterations=${summary.defaults.maxLoopIterations}, nodeTimeoutMs=${summary.defaults.nodeTimeoutMs}`,
      );
      io.stdout(`runtimeReady: ${summary.runtime.ready ? "yes" : "no"}`);
      for (const requirement of summary.runtime.requirements) {
        io.stdout(
          `runtime[${requirement.status}] ${requirement.label}: ${requirement.detail}`,
        );
      }
    }
    return 0;
  }

  if (command === "run") {
    let runtimeVariables: Readonly<Record<string, unknown>> = {};
    if (parsed.options.variablesPath !== undefined) {
      try {
        runtimeVariables = await readRuntimeVariables(
          parsed.options.variablesPath,
        );
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        io.stderr(`failed to read --variables file: ${message}`);
        return 1;
      }
    }
    if (graphqlCliTransport !== null) {
      if (rejectUnsupportedRemoteMockScenario(parsed.options, io)) {
        return 2;
      }
      try {
        const data = await executeCliGraphqlOperation({
          transport: graphqlCliTransport,
          document: `
              mutation ExecuteWorkflow($input: ExecuteWorkflowInput!) {
                executeWorkflow(input: $input) {
                  workflowExecutionId
                  sessionId
                  status
                  exitCode
                }
              }
            `,
          variables: {
            input: {
              workflowName: target,
              runtimeVariables,
              ...buildRemoteExecutionInput(parsed.options),
            },
          },
        });
        const payload = requireObjectField(
          data["executeWorkflow"],
          "executeWorkflow",
        );
        const sessionId = payload["sessionId"] as string;
        const status = payload["status"] as string;
        const exitCode = payload["exitCode"] as number;
        const summary = await fetchRemoteWorkflowRunSummary(
          graphqlCliTransport,
          sessionId,
        );

        if (parsed.options.output === "json") {
          emitJson(io, {
            sessionId,
            status,
            workflowName: summary.workflowName,
            workflowId: summary.workflowId,
            nodeExecutions: summary.nodeExecutions,
            transitions: summary.transitions,
            exitCode,
          });
        } else {
          io.stdout(`run session: ${sessionId}`);
          io.stdout(`status: ${status}`);
          io.stdout(`nodeExecutions: ${summary.nodeExecutions}`);
        }
        return exitCode;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        io.stderr(`remote run failed: ${message}`);
        return 1;
      }
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

    const loadedWorkflow = await loadWorkflowFromCatalog(target, sharedOptions);
    if (!loadedWorkflow.ok) {
      if (parsed.options.output === "json") {
        emitJson(io, loadedWorkflow.error);
      } else {
        io.stderr(`run failed: ${loadedWorkflow.error.message}`);
        if (loadedWorkflow.error.issues) {
          io.stderr(formatValidationIssues(loadedWorkflow.error.issues));
        }
      }
      return loadedWorkflow.error.code === "VALIDATION" ||
        loadedWorkflow.error.code === "INVALID_WORKFLOW_NAME" ||
        loadedWorkflow.error.code === "INVALID_SCOPE"
        ? 2
        : 1;
    }
    const workflowRunOptions = optionsForLoadedWorkflow(
      loadedWorkflow.value,
      sharedOptions,
    );

    const result = await runWorkflow(target, {
      ...workflowRunOptions,
      runtimeVariables,
      ...mockScenarioOptions,
      ...buildLocalWorkflowRunOverrides(parsed.options),
      ...(parsed.options.maxSteps === undefined
        ? {}
        : { maxSteps: parsed.options.maxSteps }),
    });

    if (!result.ok) {
      if (parsed.options.output === "json") {
        emitJson(io, result.error);
      } else {
        io.stderr(`run failed: ${result.error.message}`);
      }
      return result.error.exitCode;
    }

    if (parsed.options.output === "json") {
      emitJson(io, {
        sessionId: result.value.session.sessionId,
        status: result.value.session.status,
        workflowName: result.value.session.workflowName,
        workflowId: result.value.session.workflowId,
        source: workflowSourceJson(loadedWorkflow.value.source),
        nodeExecutions: result.value.session.nodeExecutions.length,
        transitions: result.value.session.transitions.length,
        exitCode: result.value.exitCode,
        ...(result.value.session.supervision === undefined
          ? {}
          : { supervision: result.value.session.supervision }),
      });
    } else {
      const sourceLine = formatWorkflowSource(loadedWorkflow.value.source);
      if (sourceLine !== undefined) {
        io.stdout(`source: ${sourceLine}`);
      }
      io.stdout(`run session: ${result.value.session.sessionId}`);
      io.stdout(`status: ${result.value.session.status}`);
      io.stdout(
        `nodeExecutions: ${result.value.session.nodeExecutions.length}`,
      );
    }

    return result.value.exitCode;
  }

  io.stderr(`unknown workflow command: ${command}`);
  printHelp(io);
  return 1;
}
