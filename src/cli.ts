import { readFile } from "node:fs/promises";
import { startServe, type StartedServe } from "./server/serve";
import { createWorkflowTemplate } from "./workflow/create";
import { runWorkflow } from "./workflow/engine";
import { loadWorkflowFromDisk } from "./workflow/load";
import { buildInspectionSummary } from "./workflow/inspect";
import { loadSession } from "./workflow/session-store";

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface CliDependencies {
  readonly startServe: (options: {
    host?: string;
    port?: number;
    workflowRoot?: string;
    artifactRoot?: string;
    sessionStoreRoot?: string;
    readOnly?: boolean;
    noExec?: boolean;
    fixedWorkflowName?: string;
  }) => Promise<StartedServe>;
}

interface ParsedOptions {
  readonly workflowRoot?: string;
  readonly artifactRoot?: string;
  readonly sessionStoreRoot?: string;
  readonly output: "text" | "json";
  readonly variablesPath?: string;
  readonly dryRun: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly host?: string;
  readonly port?: number;
  readonly readOnly: boolean;
  readonly noExec: boolean;
}

interface ParsedArgs {
  readonly positionals: string[];
  readonly options: ParsedOptions;
}

const DEFAULT_IO: CliIo = {
  stdout: (line: string) => console.log(line),
  stderr: (line: string) => console.error(line),
};

const DEFAULT_DEPS: CliDependencies = {
  startServe,
};

function parseNumericOption(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let workflowRoot: string | undefined;
  let artifactRoot: string | undefined;
  let sessionStoreRoot: string | undefined;
  let output: "text" | "json" = "text";
  let variablesPath: string | undefined;
  let dryRun = false;
  let maxSteps: number | undefined;
  let maxLoopIterations: number | undefined;
  let defaultTimeoutMs: number | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let readOnly = false;
  let noExec = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const readNext = (): string | undefined => {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        index += 1;
        return next;
      }
      return undefined;
    };

    switch (token) {
      case "--workflow-root":
        workflowRoot = readNext();
        break;
      case "--artifact-root":
        artifactRoot = readNext();
        break;
      case "--session-store":
        sessionStoreRoot = readNext();
        break;
      case "--variables":
        variablesPath = readNext();
        break;
      case "--output": {
        const maybeOutput = readNext();
        if (maybeOutput === "json" || maybeOutput === "text") {
          output = maybeOutput;
        }
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--max-steps":
        maxSteps = parseNumericOption(readNext());
        break;
      case "--max-loop-iterations":
        maxLoopIterations = parseNumericOption(readNext());
        break;
      case "--default-timeout-ms":
        defaultTimeoutMs = parseNumericOption(readNext());
        break;
      case "--host":
        host = readNext();
        break;
      case "--port":
        port = parseNumericOption(readNext());
        break;
      case "--read-only":
        readOnly = true;
        break;
      case "--no-exec":
        noExec = true;
        break;
      default:
        break;
    }
  }

  return {
    positionals,
    options: {
      ...(workflowRoot === undefined ? {} : { workflowRoot }),
      ...(artifactRoot === undefined ? {} : { artifactRoot }),
      ...(sessionStoreRoot === undefined ? {} : { sessionStoreRoot }),
      ...(variablesPath === undefined ? {} : { variablesPath }),
      output,
      dryRun,
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(maxLoopIterations === undefined ? {} : { maxLoopIterations }),
      ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
      readOnly,
      noExec,
    },
  };
}

function printHelp(io: CliIo): void {
  io.stdout("Usage:");
  io.stdout("  oyakata workflow <create|validate|inspect|run> <name> [options]");
  io.stdout("  oyakata session <status|resume> <session-id> [options]");
  io.stdout("  oyakata serve [workflow-name] [--host <host>] [--port <port>] [--read-only] [--no-exec]");
}

function formatValidationIssues(
  issues: readonly { severity: "error" | "warning"; path: string; message: string }[],
): string {
  return issues.map((entry) => `[${entry.severity}] ${entry.path}: ${entry.message}`).join("\n");
}

async function readRuntimeVariables(pathToJson: string): Promise<Readonly<Record<string, unknown>>> {
  const content = await readFile(pathToJson, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime variables file must contain a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function emitJson(io: CliIo, payload: unknown): void {
  io.stdout(JSON.stringify(payload, null, 2));
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  deps: CliDependencies = DEFAULT_DEPS,
): Promise<number> {
  const parsed = parseArgs(argv);
  const [scope, command, target] = parsed.positionals;

  const sharedOptions = {
    ...(parsed.options.workflowRoot === undefined ? {} : { workflowRoot: parsed.options.workflowRoot }),
    ...(parsed.options.artifactRoot === undefined ? {} : { artifactRoot: parsed.options.artifactRoot }),
    ...(parsed.options.sessionStoreRoot === undefined
      ? {}
      : { sessionStoreRoot: parsed.options.sessionStoreRoot }),
  };

  if (scope === "serve") {
    try {
      const started = await deps.startServe({
        ...sharedOptions,
        ...(parsed.options.host === undefined ? {} : { host: parsed.options.host }),
        ...(parsed.options.port === undefined ? {} : { port: parsed.options.port }),
        ...(command === undefined ? {} : { fixedWorkflowName: command }),
        ...(parsed.options.readOnly ? { readOnly: true } : {}),
        ...(parsed.options.noExec ? { noExec: true } : {}),
      });

      if (parsed.options.output === "json") {
        emitJson(io, {
          host: started.host,
          port: started.port,
          fixedWorkflowName: command,
          readOnly: parsed.options.readOnly,
          noExec: parsed.options.noExec,
        });
      } else {
        io.stdout(`serve listening on http://${started.host}:${String(started.port)}`);
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`serve failed: ${message}`);
      return 7;
    }
  }

  if (scope === undefined || command === undefined || target === undefined) {
    io.stderr("scope, command, and target are required");
    printHelp(io);
    return 2;
  }

  if (scope === "workflow") {
    if (command === "create") {
      const created = await createWorkflowTemplate(target, sharedOptions);
      if (!created.ok) {
        io.stderr(created.error.message);
        return created.error.code === "INVALID_WORKFLOW_NAME" ? 2 : 1;
      }
      if (parsed.options.output === "json") {
        emitJson(io, { workflowName: created.value.workflowName, workflowDirectory: created.value.workflowDirectory });
      } else {
        io.stdout(`created workflow: ${created.value.workflowDirectory}`);
      }
      return 0;
    }

    if (command === "validate") {
      const loaded = await loadWorkflowFromDisk(target, sharedOptions);
      if (!loaded.ok) {
        if (parsed.options.output === "json") {
          emitJson(io, loaded.error);
        } else {
          io.stderr(`validation failed: ${loaded.error.message}`);
          if (loaded.error.issues) {
            io.stderr(formatValidationIssues(loaded.error.issues));
          }
        }
        return loaded.error.code === "VALIDATION" || loaded.error.code === "INVALID_WORKFLOW_NAME" ? 2 : 1;
      }
      if (parsed.options.output === "json") {
        emitJson(io, { workflowName: loaded.value.workflowName, workflowId: loaded.value.bundle.workflow.workflowId, valid: true });
      } else {
        io.stdout(`workflow '${loaded.value.workflowName}' is valid`);
      }
      return 0;
    }

    if (command === "inspect") {
      const loaded = await loadWorkflowFromDisk(target, sharedOptions);
      if (!loaded.ok) {
        io.stderr(`inspect failed: ${loaded.error.message}`);
        if (loaded.error.issues) {
          io.stderr(formatValidationIssues(loaded.error.issues));
        }
        return loaded.error.code === "VALIDATION" || loaded.error.code === "INVALID_WORKFLOW_NAME" ? 2 : 1;
      }

      const summary = buildInspectionSummary(loaded.value);
      if (parsed.options.output === "json") {
        emitJson(io, summary);
      } else {
        io.stdout(`workflow: ${summary.workflowName}`);
        io.stdout(`workflowId: ${summary.workflowId}`);
        io.stdout(`managerNodeId: ${summary.managerNodeId}`);
        io.stdout(`nodes: ${summary.counts.nodes}, edges: ${summary.counts.edges}, loops: ${summary.counts.loops}`);
        io.stdout(
          `defaults: maxLoopIterations=${summary.defaults.maxLoopIterations}, nodeTimeoutMs=${summary.defaults.nodeTimeoutMs}`,
        );
      }
      return 0;
    }

    if (command === "run") {
      let runtimeVariables: Readonly<Record<string, unknown>> = {};
      if (parsed.options.variablesPath !== undefined) {
        try {
          runtimeVariables = await readRuntimeVariables(parsed.options.variablesPath);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "unknown error";
          io.stderr(`failed to read --variables file: ${message}`);
          return 1;
        }
      }

      const result = await runWorkflow(target, {
        ...sharedOptions,
        runtimeVariables,
        dryRun: parsed.options.dryRun,
        ...(parsed.options.maxSteps === undefined ? {} : { maxSteps: parsed.options.maxSteps }),
        ...(parsed.options.maxLoopIterations === undefined
          ? {}
          : { maxLoopIterations: parsed.options.maxLoopIterations }),
        ...(parsed.options.defaultTimeoutMs === undefined
          ? {}
          : { defaultTimeoutMs: parsed.options.defaultTimeoutMs }),
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
          nodeExecutions: result.value.session.nodeExecutions.length,
          transitions: result.value.session.transitions.length,
          exitCode: result.value.exitCode,
        });
      } else {
        io.stdout(`run session: ${result.value.session.sessionId}`);
        io.stdout(`status: ${result.value.session.status}`);
        io.stdout(`nodeExecutions: ${result.value.session.nodeExecutions.length}`);
      }

      return result.value.exitCode;
    }

    io.stderr(`unknown workflow command: ${command}`);
    printHelp(io);
    return 1;
  }

  if (scope === "session") {
    if (command === "status") {
      const session = await loadSession(target, sharedOptions);
      if (!session.ok) {
        io.stderr(session.error.message);
        return 1;
      }

      if (parsed.options.output === "json") {
        emitJson(io, session.value);
      } else {
        io.stdout(`sessionId: ${session.value.sessionId}`);
        io.stdout(`workflow: ${session.value.workflowName}`);
        io.stdout(`status: ${session.value.status}`);
        io.stdout(`currentNodeId: ${session.value.currentNodeId ?? "-"}`);
        io.stdout(`queueLength: ${session.value.queue.length}`);
      }
      return 0;
    }

    if (command === "resume") {
      const session = await loadSession(target, sharedOptions);
      if (!session.ok) {
        io.stderr(session.error.message);
        return 1;
      }

      const result = await runWorkflow(session.value.workflowName, {
        ...sharedOptions,
        resumeSessionId: session.value.sessionId,
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

    io.stderr(`unknown session command: ${command}`);
    printHelp(io);
    return 1;
  }

  io.stderr(`unknown scope: ${scope}`);
  printHelp(io);
  return 1;
}
