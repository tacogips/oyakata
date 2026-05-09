import {
  DEFAULT_GRAPHQL_ENDPOINT,
  executeGraphqlRequest,
} from "./graphql/client";
import { parseHookVendorOption } from "./hook/detect-vendor";
import { createReadHookStdin, runHookCommand } from "./hook/index";
import { startServe, type StartedServe } from "./server/serve";
import type { EventListenerHandle } from "./events/listener-service";
import { inferRootDataDirFromExplicitStorageRoots } from "./workflow/paths";
import { resolveWorkflowSource } from "./workflow/catalog";
import type { ResolvedWorkflowSource } from "./workflow/types";
import { callStep } from "./workflow/call-step";
import { buildHookConfigurationSnippet } from "./hook/config";
import { emitJson } from "./cli/helpers";
import {
  parseArgs,
  normalizeCliPositionals,
  parseWorkflowScopeOption,
  HOOK_VENDOR_USAGE,
  HOOK_VENDOR_EXPECTED,
} from "./cli/arg-parser";
import {
  resolveCliEnv,
  resolveGraphqlCliTransport,
  buildLocalCallStepOverrides,
} from "./cli/graphql-remote";
import {
  readGraphqlVariables,
  readDirectCallMessage,
  readMockScenarioOption,
} from "./cli/io-helpers";
import { printHelp } from "./cli/helpers";
import { handleEventsScope } from "./cli/handle-events";
import { handleWorkflowScope } from "./cli/handle-workflow";
import { handleSessionScope } from "./cli/handle-session";
export type { CliIo, CliDependencies } from "./cli/types";

async function waitForProcessShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve();
    };
    const onSigint = (): void => finish();
    const onSigterm = (): void => finish();
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

import type { CliIo, CliDependencies } from "./cli/types";

const DEFAULT_IO: CliIo = {
  stdout: (line: string) => console.log(line),
  stderr: (line: string) => console.error(line),
};

const DEFAULT_DEPS: CliDependencies = {
  startServe,
  isInteractiveTerminal: () =>
    process.stdin.isTTY === true && process.stdout.isTTY === true,
  readStdin: createReadHookStdin(process.stdin),
  waitForServeShutdown: async (_started: StartedServe) =>
    waitForProcessShutdownSignal(),
  waitForEventListenerShutdown: async (_started: EventListenerHandle) =>
    waitForProcessShutdownSignal(),
};

export async function runCli(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  deps: CliDependencies = DEFAULT_DEPS,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    io.stderr(parsed.error);
    return 2;
  }
  const positionals = normalizeCliPositionals(parsed.positionals);
  const [scope, command, target] = positionals;
  const env = resolveCliEnv(deps);
  const envWorkflowScope = env["DIVEDRA_WORKFLOW_SCOPE"];
  if (
    parsed.options.workflowScope === undefined &&
    envWorkflowScope !== undefined &&
    envWorkflowScope.length > 0 &&
    parseWorkflowScopeOption(envWorkflowScope) === undefined
  ) {
    io.stderr(
      `invalid DIVEDRA_WORKFLOW_SCOPE value '${envWorkflowScope}'; expected auto, project, or user`,
    );
    return 2;
  }
  const inferredRootDataDir = inferRootDataDirFromExplicitStorageRoots({
    ...(parsed.options.artifactRoot === undefined
      ? {}
      : { artifactRoot: parsed.options.artifactRoot }),
    ...(parsed.options.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: parsed.options.sessionStoreRoot }),
  });

  const sharedOptions = {
    ...(parsed.options.workflowRoot === undefined
      ? {}
      : { workflowRoot: parsed.options.workflowRoot }),
    ...(parsed.options.workflowScope === undefined
      ? {}
      : { workflowScope: parsed.options.workflowScope }),
    ...(parsed.options.userRoot === undefined
      ? {}
      : { userRoot: parsed.options.userRoot }),
    ...(parsed.options.projectRoot === undefined
      ? {}
      : { projectRoot: parsed.options.projectRoot }),
    ...(parsed.options.addonRoot === undefined
      ? {}
      : { addonRoot: parsed.options.addonRoot }),
    ...(parsed.options.artifactRoot === undefined
      ? {}
      : { artifactRoot: parsed.options.artifactRoot }),
    ...(inferredRootDataDir === undefined
      ? {}
      : { rootDataDir: inferredRootDataDir }),
    ...(parsed.options.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: parsed.options.sessionStoreRoot }),
    env,
  };
  const graphqlCliTransport = resolveGraphqlCliTransport(
    parsed.options,
    env,
    deps,
  );

  if (scope === "gql") {
    const document = positionals.slice(1).join(" ").trim();
    if (document.length === 0) {
      io.stderr("GraphQL document is required");
      io.stderr("usage: divedra gql <graphql-document> [options]");
      return 2;
    }

    let variables: Readonly<Record<string, unknown>> | undefined;
    try {
      variables = await readGraphqlVariables(parsed.options.variablesPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to read GraphQL variables: ${message}`);
      return 1;
    }

    const endpoint =
      parsed.options.endpoint ??
      env["DIVEDRA_GRAPHQL_ENDPOINT"] ??
      DEFAULT_GRAPHQL_ENDPOINT;
    const authTokenEnvName =
      parsed.options.authTokenEnv ?? "DIVEDRA_MANAGER_AUTH_TOKEN";
    const authToken =
      parsed.options.authToken ?? env[authTokenEnvName] ?? undefined;
    const ambientManagerSessionId = env["DIVEDRA_MANAGER_SESSION_ID"];
    const managerSessionId =
      typeof ambientManagerSessionId === "string" &&
      ambientManagerSessionId.length > 0
        ? ambientManagerSessionId
        : undefined;

    try {
      const response = await executeGraphqlRequest({
        endpoint,
        document,
        ...(variables === undefined ? {} : { variables }),
        ...(authToken === undefined ? {} : { authToken }),
        ...(managerSessionId === undefined ? {} : { managerSessionId }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });

      if (parsed.options.output === "json") {
        emitJson(io, response);
      } else if (response.data !== undefined) {
        emitJson(io, response.data);
      } else {
        emitJson(io, response);
      }

      if (response.errors !== undefined && response.errors.length > 0) {
        if (parsed.options.output !== "json") {
          for (const error of response.errors) {
            io.stderr(error.message);
          }
        }
        return 1;
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`GraphQL request failed: ${message}`);
      return 1;
    }
  }

  if (scope === "hook") {
    const explicitVendor = parseHookVendorOption(parsed.options.vendor);
    if (command !== undefined) {
      if (command !== "snippet") {
        io.stderr("unknown hook subcommand");
        io.stderr(`usage: divedra hook snippet --vendor ${HOOK_VENDOR_USAGE}`);
        return 2;
      }
      if (target !== undefined) {
        io.stderr("hook snippet does not accept extra positional arguments");
        io.stderr(`usage: divedra hook snippet --vendor ${HOOK_VENDOR_USAGE}`);
        return 2;
      }
      if (parsed.options.vendor === undefined) {
        io.stderr(
          `--vendor is required for hook snippet; expected ${HOOK_VENDOR_EXPECTED}`,
        );
        return 2;
      }
      if (explicitVendor === undefined) {
        io.stderr(
          `invalid --vendor value '${parsed.options.vendor}'; expected ${HOOK_VENDOR_EXPECTED}`,
        );
        return 2;
      }
      emitJson(io, buildHookConfigurationSnippet(explicitVendor));
      return 0;
    }

    if (positionals.length > 1) {
      io.stderr("hook does not accept positional arguments");
      io.stderr(`usage: divedra hook [--vendor ${HOOK_VENDOR_USAGE}]`);
      return 2;
    }

    if (parsed.options.vendor !== undefined && explicitVendor === undefined) {
      io.stderr(
        `invalid --vendor value '${parsed.options.vendor}'; expected ${HOOK_VENDOR_EXPECTED}`,
      );
      return 2;
    }

    return runHookCommand({
      deps: {
        readStdin:
          deps.readStdin ??
          DEFAULT_DEPS.readStdin ??
          createReadHookStdin(process.stdin),
        env,
        cwd: process.cwd(),
        ...(sharedOptions.rootDataDir === undefined
          ? {}
          : { rootDataDir: sharedOptions.rootDataDir }),
        ...(sharedOptions.artifactRoot === undefined
          ? {}
          : { artifactRoot: sharedOptions.artifactRoot }),
      },
      ...(explicitVendor === undefined ? {} : { explicitVendor }),
      io,
    });
  }

  if (scope === "events") {
    return handleEventsScope({
      io,
      deps,
      parsed,
      positionals,
      command,
      target,
      sharedOptions,
      graphqlCliTransport,
      env,
    });
  }

  if (scope === "serve") {
    const serveWorkflowName = command;
    try {
      let serveContext: import("./workflow/types").LoadOptions & {
        readonly fixedWorkflowName?: string;
        readonly fixedResolvedWorkflowSource?: ResolvedWorkflowSource;
      } = sharedOptions;
      if (serveWorkflowName !== undefined) {
        const resolved = await resolveWorkflowSource(
          serveWorkflowName,
          sharedOptions,
        );
        if (!resolved.ok) {
          io.stderr(`serve failed: ${resolved.error.message}`);
          return 7;
        }
        serveContext = {
          ...sharedOptions,
          fixedWorkflowName: serveWorkflowName,
          fixedResolvedWorkflowSource: resolved.value,
        };
      }
      const started = await deps.startServe({
        ...serveContext,
        ...(parsed.options.host === undefined
          ? {}
          : { host: parsed.options.host }),
        ...(parsed.options.port === undefined
          ? {}
          : { port: parsed.options.port }),
        ...(parsed.options.readOnly ? { readOnly: true } : {}),
        ...(parsed.options.noExec ? { noExec: true } : {}),
      });

      if (parsed.options.output === "json") {
        emitJson(io, {
          host: started.host,
          port: started.port,
          fixedWorkflowName: serveWorkflowName,
          readOnly: parsed.options.readOnly,
          noExec: parsed.options.noExec,
        });
      } else {
        io.stdout(
          `serve listening on http://${started.host}:${String(started.port)}`,
        );
      }
      const waitForServeShutdown =
        deps.waitForServeShutdown ?? DEFAULT_DEPS.waitForServeShutdown;
      try {
        if (waitForServeShutdown !== undefined) {
          await waitForServeShutdown(started);
        }
      } finally {
        started.stop();
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`serve failed: ${message}`);
      return 7;
    }
  }

  if (scope === "call-step") {
    const workflowId = command;
    const workflowRunId = target;
    const stepId = positionals[3];
    if (
      workflowId === undefined ||
      workflowRunId === undefined ||
      stepId === undefined
    ) {
      io.stderr("workflow id, workflow run id, and step id are required");
      io.stderr(
        "usage: divedra call-step <workflow-id> <workflow-run-id> <step-id> [--message-json <json> | --message-file <path>] [--prompt-variant <name>] [--continue-session] [--timeout-ms <ms>] [--resume-step-exec <id>] [options]",
      );
      return 2;
    }
    if (graphqlCliTransport !== null) {
      io.stderr(
        "call-step currently supports local execution only; omit --endpoint",
      );
      return 2;
    }

    let message: unknown;
    try {
      message = await readDirectCallMessage(parsed.options);
    } catch (error: unknown) {
      const messageText =
        error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to read call-step message: ${messageText}`);
      return 1;
    }

    let mockScenarioOptions: Readonly<{
      mockScenario?: import("./workflow/adapter").MockNodeScenario;
    }> = {};
    try {
      mockScenarioOptions = await readMockScenarioOption(
        parsed.options.mockScenarioPath,
      );
    } catch (error: unknown) {
      const messageText =
        error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to read --mock-scenario file: ${messageText}`);
      return 1;
    }

    const result = await callStep({
      ...sharedOptions,
      workflowId,
      workflowRunId,
      stepId,
      ...buildLocalCallStepOverrides(parsed.options),
      ...mockScenarioOptions,
      ...(message === undefined ? {} : { message }),
    });

    if (!result.ok) {
      if (parsed.options.output === "json") {
        emitJson(io, result.error);
      } else {
        io.stderr(`call-step failed: ${result.error.message}`);
        if (result.error.nodeExecution !== undefined) {
          io.stderr(`nodeExecId: ${result.error.nodeExecution.nodeExecId}`);
          io.stderr(`status: ${result.error.nodeExecution.status}`);
        }
      }
      return result.error.exitCode;
    }

    if (parsed.options.output === "json") {
      emitJson(io, {
        sessionId: result.value.session.sessionId,
        stepId,
        nodeExecId: result.value.nodeExecution.nodeExecId,
        status: result.value.nodeExecution.status,
        output: result.value.output,
        outputRef: result.value.outputRef,
        exitCode: result.value.exitCode,
      });
    } else {
      io.stdout(`sessionId: ${result.value.session.sessionId}`);
      io.stdout(`stepId: ${stepId}`);
      io.stdout(`nodeExecId: ${result.value.nodeExecution.nodeExecId}`);
      io.stdout(`status: ${result.value.nodeExecution.status}`);
    }
    return result.value.exitCode;
  }

  if (scope === undefined || command === undefined) {
    io.stderr("scope and command are required");
    printHelp(io);
    return 2;
  }
  if (target === undefined && !(scope === "workflow" && command === "list")) {
    io.stderr("scope, command, and target are required");
    printHelp(io);
    return 2;
  }

  if (
    parsed.options.output === "table" &&
    !(scope === "workflow" && (command === "list" || command === "status"))
  ) {
    io.stderr(
      "`--output table` is only supported for workflow list and workflow status",
    );
    return 2;
  }

  if (scope === "workflow") {
    return handleWorkflowScope({
      io,
      deps,
      parsed,
      positionals,
      command,
      target,
      sharedOptions,
      graphqlCliTransport,
      env,
    });
  }

  if (scope === "session") {
    return handleSessionScope({
      io,
      deps,
      parsed,
      positionals,
      command,
      target,
      sharedOptions,
      graphqlCliTransport,
      env,
    });
  }

  io.stderr(`unknown scope: ${scope}`);
  printHelp(io);
  return 1;
}
