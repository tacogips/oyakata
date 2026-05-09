import { SUPPORTED_HOOK_VENDORS } from "../hook/types";
import { normalizeAutoImprovePolicy } from "../workflow/auto-improve-policy";
import type {
  AutoImprovePolicy,
  WorkflowScopeSelector,
} from "../workflow/types";
import type { AutoImproveCliInputs, ParsedArgs } from "./types";
import type { NodeExecutionRecord } from "../workflow/session";
import type { RuntimeEventReplyDispatchStatus } from "../workflow/runtime-db";

export const HOOK_VENDOR_USAGE = SUPPORTED_HOOK_VENDORS.join("|");
export const HOOK_VENDOR_EXPECTED = SUPPORTED_HOOK_VENDORS.map(
  (vendor) => `'${vendor}'`,
).join(" or ");

export function parseAutoImprovePolicyFromCliFlags(
  input: AutoImproveCliInputs,
): {
  readonly policy?: AutoImprovePolicy;
  readonly error?: string;
} {
  const normalized = normalizeAutoImprovePolicy(input);
  if (!normalized.ok) {
    return { error: normalized.error };
  }
  return normalized.value === undefined ? {} : { policy: normalized.value };
}

export function normalizeCliPositionals(
  positionals: readonly string[],
): string[] {
  if (positionals[0] === "cli" && positionals[1] === "workflow") {
    return positionals.slice(1);
  }
  return [...positionals];
}

function parseNumericOption(
  flagName: string,
  value: string | undefined,
): { readonly value?: number; readonly error?: string } {
  if (value === undefined) {
    return { error: `${flagName} requires a numeric value` };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return {
      error: `invalid ${flagName} value '${value}'; expected a number`,
    };
  }
  return { value: parsed };
}

function parseRequiredStringOption(
  flagName: string,
  value: string | undefined,
  expectation?: string,
): { readonly value?: string; readonly error?: string } {
  if (value !== undefined) {
    return { value };
  }
  return {
    error:
      expectation === undefined
        ? `${flagName} requires a value`
        : `${flagName} requires a value: ${expectation}`,
  };
}

function parseEnumOption<const T extends string>(
  flagName: string,
  value: string | undefined,
  allowedValues: readonly T[],
  expectation: string,
): { readonly value?: T; readonly error?: string } {
  const parsedString = parseRequiredStringOption(flagName, value, expectation);
  if (parsedString.error !== undefined) {
    return { error: parsedString.error };
  }
  const parsedValue = parsedString.value;
  if (
    parsedValue !== undefined &&
    allowedValues.some((allowed) => allowed === parsedValue)
  ) {
    return { value: parsedValue as T };
  }
  return {
    error: `invalid ${flagName} value '${parsedValue}'; expected ${expectation}`,
  };
}

export function parseEnvBooleanFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function parseWorkflowScopeOption(
  value: string | undefined,
): WorkflowScopeSelector | undefined {
  return value === "auto" || value === "project" || value === "user"
    ? value
    : undefined;
}

export function parseReplyDispatchStatus(
  value: string | undefined,
): RuntimeEventReplyDispatchStatus | undefined {
  if (
    value === "dispatching" ||
    value === "sent" ||
    value === "queued" ||
    value === "failed"
  ) {
    return value;
  }
  return undefined;
}

export function parseStepRunExecutionStatusFilter(
  raw: string | undefined,
):
  | { ok: true; value: NodeExecutionRecord["status"] | undefined }
  | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  const allowed: ReadonlySet<string> = new Set([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "skipped",
  ]);
  if (!allowed.has(trimmed)) {
    return {
      ok: false,
      error: `invalid --status '${raw}' for session step-runs (expected succeeded, failed, timed_out, cancelled, or skipped)`,
    };
  }
  return { ok: true, value: trimmed as NodeExecutionRecord["status"] };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let workflowRoot: string | undefined;
  let workflowScope: WorkflowScopeSelector | undefined;
  let userRoot: string | undefined;
  let projectRoot: string | undefined;
  let addonRoot: string | undefined;
  let artifactRoot: string | undefined;
  let sessionStoreRoot: string | undefined;
  let workingDirectory: string | undefined;
  let workerOnly = false;
  let output: "text" | "json" | "table" = "text";
  let format: "text" | "json" | "jsonl" | undefined;
  let variablesPath: string | undefined;
  let dryRun = false;
  let mockScenarioPath: string | undefined;
  let maxSteps: number | undefined;
  let maxLoopIterations: number | undefined;
  let defaultTimeoutMs: number | undefined;
  let timeoutMs: number | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let endpoint: string | undefined;
  let authToken: string | undefined;
  let authTokenEnv: string | undefined;
  let filePath: string | undefined;
  let readOnly = false;
  let noExec = false;
  let messageJson: string | undefined;
  let messageFile: string | undefined;
  let promptVariant: string | undefined;
  let continueSession = false;
  let resumeStepExecId: string | undefined;
  let vendor: string | undefined;
  let eventRoot: string | undefined;
  let eventFile: string | undefined;
  let sourceId: string | undefined;
  let status: string | undefined;
  let limit: number | undefined;
  let reason: string | undefined;
  let parseError: string | undefined;
  let autoImprove = false;
  let superviserWorkflowId: string | undefined;
  let monitorIntervalMs: number | undefined;
  let stallTimeoutMs: number | undefined;
  let maxSupervisedAttempts: number | undefined;
  let maxWorkflowPatches: number | undefined;
  let workflowMutationMode: "execution-copy" | "in-place" | undefined;
  let noAllowTargetedRerun = false;
  let firstAutoImprovePolicyFlag: string | undefined;
  let nestedSuperviser = false;
  let continuationStartStepId: string | undefined;
  let continuationAfterStepRunId: string | undefined;
  let stepRunsFilterStepId: string | undefined;

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
    const markAutoImprovePolicyFlag = (): void => {
      firstAutoImprovePolicyFlag ??= token;
    };

    switch (token) {
      case "--workflow-root": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        workflowRoot = parsedString.value;
        break;
      }
      case "--scope":
        {
          const rawScope = readNext();
          const parsedScope = parseWorkflowScopeOption(rawScope);
          if (parsedScope === undefined) {
            parseError =
              rawScope === undefined
                ? "--scope requires a value: auto, project, or user"
                : `invalid --scope value '${rawScope}'; expected auto, project, or user`;
          } else {
            workflowScope = parsedScope;
          }
        }
        break;
      case "--user-root": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        userRoot = parsedString.value;
        break;
      }
      case "--project-root": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        projectRoot = parsedString.value;
        break;
      }
      case "--addon-root": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        addonRoot = parsedString.value;
        break;
      }
      case "--artifact-root": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        artifactRoot = parsedString.value;
        break;
      }
      case "--session-store": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        sessionStoreRoot = parsedString.value;
        break;
      }
      case "--working-dir":
      case "--working-directory": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        workingDirectory = parsedString.value;
        break;
      }
      case "--worker-only":
        workerOnly = true;
        break;
      case "--variables": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        variablesPath = parsedString.value;
        break;
      }
      case "--output": {
        const parsedOutput = parseEnumOption(
          token,
          readNext(),
          ["json", "text", "table"],
          "json, text, or table",
        );
        if (parsedOutput.error !== undefined) {
          parseError = parsedOutput.error;
          break;
        }
        if (parsedOutput.value !== undefined) {
          output = parsedOutput.value;
        }
        break;
      }
      case "--format": {
        const parsedFormat = parseEnumOption(
          token,
          readNext(),
          ["json", "jsonl", "text"],
          "json, jsonl, or text",
        );
        if (parsedFormat.error !== undefined) {
          parseError = parsedFormat.error;
          break;
        }
        if (parsedFormat.value !== undefined) {
          format = parsedFormat.value;
        }
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--mock-scenario": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        mockScenarioPath = parsedString.value;
        break;
      }
      case "--max-steps":
        {
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          maxSteps = parsedNumber.value;
        }
        break;
      case "--max-loop-iterations":
        {
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          maxLoopIterations = parsedNumber.value;
        }
        break;
      case "--default-timeout-ms":
        {
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          defaultTimeoutMs = parsedNumber.value;
        }
        break;
      case "--timeout-ms":
        {
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          timeoutMs = parsedNumber.value;
        }
        break;
      case "--host": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        host = parsedString.value;
        break;
      }
      case "--port":
        {
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          port = parsedNumber.value;
        }
        break;
      case "--endpoint": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        endpoint = parsedString.value;
        break;
      }
      case "--auth-token": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        authToken = parsedString.value;
        break;
      }
      case "--auth-token-env": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        authTokenEnv = parsedString.value;
        break;
      }
      case "--file": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        filePath = parsedString.value;
        break;
      }
      case "--read-only":
        readOnly = true;
        break;
      case "--no-exec":
        noExec = true;
        break;
      case "--message-json": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        messageJson = parsedString.value;
        break;
      }
      case "--message-file": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        messageFile = parsedString.value;
        break;
      }
      case "--prompt-variant": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        promptVariant = parsedString.value;
        break;
      }
      case "--continue-session":
        continueSession = true;
        break;
      case "--resume-node-exec":
        readNext();
        parseError ??=
          "--resume-node-exec has been removed; use --resume-step-exec";
        break;
      case "--resume-step-exec": {
        const nextResumeExec = readNext();
        if (nextResumeExec === undefined) {
          parseError = `${token} requires an execution record id`;
          break;
        }
        resumeStepExecId = nextResumeExec;
        break;
      }
      case "--vendor": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        vendor = parsedString.value;
        break;
      }
      case "--event-root": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        eventRoot = parsedString.value;
        break;
      }
      case "--event-file": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        eventFile = parsedString.value;
        break;
      }
      case "--source": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        sourceId = parsedString.value;
        break;
      }
      case "--status": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        status = parsedString.value;
        break;
      }
      case "--limit":
        {
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          limit = parsedNumber.value;
        }
        break;
      case "--reason": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        reason = parsedString.value;
        break;
      }
      case "--auto-improve":
        autoImprove = true;
        break;
      case "--superviser-workflow":
      case "--supervisor-workflow": {
        markAutoImprovePolicyFlag();
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        superviserWorkflowId = parsedString.value;
        break;
      }
      case "--monitor-interval-ms":
        {
          markAutoImprovePolicyFlag();
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          monitorIntervalMs = parsedNumber.value;
        }
        break;
      case "--stall-timeout-ms":
        {
          markAutoImprovePolicyFlag();
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          stallTimeoutMs = parsedNumber.value;
        }
        break;
      case "--max-supervised-attempts":
        {
          markAutoImprovePolicyFlag();
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          maxSupervisedAttempts = parsedNumber.value;
        }
        break;
      case "--max-workflow-patches":
        {
          markAutoImprovePolicyFlag();
          const parsedNumber = parseNumericOption(token, readNext());
          if (parsedNumber.error !== undefined) {
            parseError = parsedNumber.error;
            break;
          }
          maxWorkflowPatches = parsedNumber.value;
        }
        break;
      case "--workflow-mutation-mode": {
        markAutoImprovePolicyFlag();
        const parsedMode = parseEnumOption(
          token,
          readNext(),
          ["execution-copy", "in-place"],
          "execution-copy or in-place",
        );
        if (parsedMode.error !== undefined) {
          parseError = parsedMode.error;
          break;
        }
        if (parsedMode.value !== undefined) {
          workflowMutationMode = parsedMode.value;
        }
        break;
      }
      case "--no-allow-targeted-rerun":
      case "--disable-targeted-rerun":
        markAutoImprovePolicyFlag();
        noAllowTargetedRerun = true;
        break;
      case "--nested-superviser":
      case "--nested-supervisor":
        markAutoImprovePolicyFlag();
        nestedSuperviser = true;
        break;
      case "--start-step": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        continuationStartStepId = parsedString.value;
        break;
      }
      case "--after-step-run": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        continuationAfterStepRunId = parsedString.value;
        break;
      }
      case "--step": {
        const parsedString = parseRequiredStringOption(token, readNext());
        if (parsedString.error !== undefined) {
          parseError = parsedString.error;
          break;
        }
        stepRunsFilterStepId = parsedString.value;
        break;
      }
      default:
        break;
    }

    if (parseError !== undefined) {
      break;
    }
  }

  const autoImproveInputs = {
    enabled: autoImprove,
    ...(superviserWorkflowId === undefined ? {} : { superviserWorkflowId }),
    ...(monitorIntervalMs === undefined ? {} : { monitorIntervalMs }),
    ...(stallTimeoutMs === undefined ? {} : { stallTimeoutMs }),
    ...(maxSupervisedAttempts === undefined ? {} : { maxSupervisedAttempts }),
    ...(maxWorkflowPatches === undefined ? {} : { maxWorkflowPatches }),
    ...(workflowMutationMode === undefined ? {} : { workflowMutationMode }),
    ...(noAllowTargetedRerun ? { allowTargetedRerun: false } : {}),
  } as const;
  const autoImprovePolicy =
    parseAutoImprovePolicyFromCliFlags(autoImproveInputs);
  if (parseError === undefined) {
    if (nestedSuperviser && !autoImprove) {
      parseError =
        "--nested-superviser / --nested-supervisor require --auto-improve";
    } else if (!autoImprove && firstAutoImprovePolicyFlag !== undefined) {
      parseError = `${firstAutoImprovePolicyFlag} requires --auto-improve`;
    }
  }
  if (parseError === undefined && autoImprovePolicy.error !== undefined) {
    parseError = `invalid --auto-improve policy: ${autoImprovePolicy.error}`;
  }

  return {
    positionals,
    options: {
      ...(workflowRoot === undefined ? {} : { workflowRoot }),
      ...(workflowScope === undefined ? {} : { workflowScope }),
      ...(userRoot === undefined ? {} : { userRoot }),
      ...(projectRoot === undefined ? {} : { projectRoot }),
      ...(addonRoot === undefined ? {} : { addonRoot }),
      ...(artifactRoot === undefined ? {} : { artifactRoot }),
      ...(sessionStoreRoot === undefined ? {} : { sessionStoreRoot }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      workerOnly,
      ...(format === undefined ? {} : { format }),
      ...(variablesPath === undefined ? {} : { variablesPath }),
      ...(mockScenarioPath === undefined ? {} : { mockScenarioPath }),
      output,
      dryRun,
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(maxLoopIterations === undefined ? {} : { maxLoopIterations }),
      ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(authToken === undefined ? {} : { authToken }),
      ...(authTokenEnv === undefined ? {} : { authTokenEnv }),
      ...(filePath === undefined ? {} : { filePath }),
      readOnly,
      noExec,
      ...(messageJson === undefined ? {} : { messageJson }),
      ...(messageFile === undefined ? {} : { messageFile }),
      ...(promptVariant === undefined ? {} : { promptVariant }),
      continueSession,
      ...(resumeStepExecId === undefined ? {} : { resumeStepExecId }),
      ...(vendor === undefined ? {} : { vendor }),
      ...(eventRoot === undefined ? {} : { eventRoot }),
      ...(eventFile === undefined ? {} : { eventFile }),
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
      ...(reason === undefined ? {} : { reason }),
      ...(autoImprovePolicy.policy === undefined
        ? {}
        : { autoImprove: autoImprovePolicy.policy }),
      ...(nestedSuperviser ? { nestedSuperviser: true } : {}),
      ...(continuationStartStepId === undefined
        ? {}
        : { continuationStartStepId }),
      ...(continuationAfterStepRunId === undefined
        ? {}
        : { continuationAfterStepRunId }),
      ...(stepRunsFilterStepId === undefined ? {} : { stepRunsFilterStepId }),
    },
    ...(parseError === undefined ? {} : { error: parseError }),
  };
}
