import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveSession } from "./session-store";
import type { SessionStoreOptions } from "./session-store";
import type { WorkflowSessionState } from "./session";
import type { NodePayload, WorkflowEdge } from "./types";
import { evaluateBranch } from "./semantics";
import type { WorkflowTimeoutPolicy } from "./types";
import {
  err,
  ok,
  type Result,
  workflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunFailure,
  type JsonSchemaValidationError,
} from "./engine-types";

export function mergeVariables(
  nodeVariables: Readonly<Record<string, unknown>>,
  runtimeVariables: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { ...nodeVariables, ...runtimeVariables };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function addMillisecondsToIso(
  timestamp: string,
  milliseconds: number,
): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

export function nextNodeExecId(counter: number): string {
  return `exec-${String(counter).padStart(6, "0")}`;
}

export function nextManagerSessionId(nodeExecId: string): string {
  return `mgrsess-${nodeExecId}`;
}

export function nextCommunicationId(counter: number): string {
  return `comm-${String(counter).padStart(6, "0")}`;
}

export function initialDeliveryAttemptId(): string {
  return "attempt-000001";
}

export function resolveTimeoutMs(input: {
  readonly node: NodePayload;
  readonly stepTimeoutMs?: number;
  readonly workflowTimeoutMs: number;
}): {
  readonly timeoutMs: number;
  readonly source: "step" | "node" | "workflow-default";
} {
  if (input.stepTimeoutMs !== undefined) {
    return {
      timeoutMs: input.stepTimeoutMs,
      source: "step",
    };
  }
  if (input.node.timeoutMs !== undefined) {
    return {
      timeoutMs: input.node.timeoutMs,
      source: "node",
    };
  }
  return {
    timeoutMs: input.workflowTimeoutMs,
    source: "workflow-default",
  };
}

export function resolveTimeoutRestartBudget(
  timeoutPolicy: WorkflowTimeoutPolicy | undefined,
  options: WorkflowRunOptions,
  restartAttempt: number,
): { readonly allowRestart: boolean; readonly maxRestarts: number } {
  if (options.restartOnStuck === false) {
    return { allowRestart: false, maxRestarts: 0 };
  }
  const optRestart = options.restartOnStuck ?? true;
  const optMax = options.maxStuckRestarts ?? 2;
  if (timeoutPolicy === undefined) {
    return { allowRestart: optRestart, maxRestarts: optMax };
  }
  switch (timeoutPolicy.onTimeout) {
    case "fail":
      return { allowRestart: false, maxRestarts: 0 };
    case "retry-same-step":
      return {
        allowRestart: true,
        maxRestarts: timeoutPolicy.maxRetries ?? optMax,
      };
    case "jump-to-step": {
      const retriesBeforeJump = timeoutPolicy.maxRetries ?? 0;
      return {
        allowRestart: restartAttempt < retriesBeforeJump,
        maxRestarts: retriesBeforeJump,
      };
    }
    default:
      return { allowRestart: optRestart, maxRestarts: optMax };
  }
}

export function evaluateEdge(
  edge: WorkflowEdge,
  output: Readonly<Record<string, unknown>>,
): boolean {
  return evaluateBranch({ when: edge.when, output });
}

export async function persistTerminalSessionState(
  session: WorkflowSessionState,
  options: SessionStoreOptions,
  contextMessage: string,
): Promise<Result<void, string>> {
  const saved = await saveSession(session, options);
  if (!saved.ok) {
    return err(
      `${contextMessage}; additionally failed to persist terminal session state: ${saved.error.message}`,
    );
  }
  return ok(undefined);
}

export async function persistCompletedSessionState(
  session: WorkflowSessionState,
  options: SessionStoreOptions,
): Promise<Result<void, string>> {
  const saved = await saveSession(session, options);
  if (!saved.ok) {
    return err(
      `failed to persist completed workflow session state: ${saved.error.message}`,
    );
  }
  return ok(undefined);
}

export async function failTerminalSession(
  session: WorkflowSessionState,
  options: SessionStoreOptions,
  message: string,
): Promise<Result<never, WorkflowRunFailure>> {
  const failed: WorkflowSessionState = {
    ...session,
    status: "failed",
    lastError: message,
  };
  const persisted = await persistTerminalSessionState(failed, options, message);
  return err(
    workflowRunFailure(1, persisted.ok ? message : persisted.error, session),
  );
}

export function stableJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function outputArtifactJsonText(payload: unknown): string {
  return `${stableJson(payload)}\n`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function resolveOutputValidationAttempts(node: NodePayload): number {
  if (node.output === undefined) {
    return 1;
  }
  if (node.output.maxValidationAttempts !== undefined) {
    return Math.max(1, node.output.maxValidationAttempts);
  }
  return node.output.jsonSchema === undefined ? 1 : 3;
}

export function buildOutputPublicationPolicy(): {
  readonly owner: "runtime";
  readonly finalArtifactWrite: "runtime-only";
  readonly mailboxWrite: "runtime-only-after-validation";
  readonly candidateSubmission: "inline-json-or-reserved-candidate-file";
  readonly futureCommunicationIdsExposed: false;
} {
  return {
    owner: "runtime",
    finalArtifactWrite: "runtime-only",
    mailboxWrite: "runtime-only-after-validation",
    candidateSubmission: "inline-json-or-reserved-candidate-file",
    futureCommunicationIdsExposed: false,
  };
}

export function nextOutputAttemptId(counter: number): string {
  return `attempt-${String(counter).padStart(6, "0")}`;
}

export function buildReservedCandidateSubmissionPath(input: {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly outputAttemptId: string;
}): string {
  return path.join(
    os.tmpdir(),
    "divedra-output-candidates",
    input.workflowId,
    input.workflowExecutionId,
    input.nodeId,
    input.nodeExecId,
    input.outputAttemptId,
    "candidate.json",
  );
}

export async function cleanupReservedCandidateSubmissionPath(
  candidatePath: string,
): Promise<void> {
  await rm(path.dirname(candidatePath), { recursive: true, force: true });
}

export const MAX_OUTPUT_VALIDATION_FEEDBACK_ERRORS = 8;
export const MAX_OUTPUT_VALIDATION_FEEDBACK_MESSAGE_LENGTH = 240;
export const NON_CONTRACT_CANDIDATE_FILE_ERROR =
  "adapter output.candidateFilePath is only supported when node.output is configured";
export const WORKFLOW_EXTERNAL_INPUT_NODE_ID = "__workflow-input-mailbox__";
export const WORKFLOW_EXTERNAL_OUTPUT_NODE_ID = "__workflow-output-mailbox__";

export function formatOutputValidationErrors(
  errors: readonly JsonSchemaValidationError[],
): readonly JsonSchemaValidationError[] {
  return errors
    .slice(0, MAX_OUTPUT_VALIDATION_FEEDBACK_ERRORS)
    .map((entry) => ({
      path: entry.path,
      message:
        entry.message.length <= MAX_OUTPUT_VALIDATION_FEEDBACK_MESSAGE_LENGTH
          ? entry.message
          : `${entry.message.slice(0, MAX_OUTPUT_VALIDATION_FEEDBACK_MESSAGE_LENGTH - 3)}...`,
    }));
}

export function buildRetryValidationFeedback(
  errors: readonly JsonSchemaValidationError[],
): readonly JsonSchemaValidationError[] {
  if (errors.length === 0) {
    return [];
  }
  return formatOutputValidationErrors(errors);
}

export function buildOutputPromptText(input: {
  readonly basePromptText: string;
  readonly node: NodePayload;
  readonly candidatePath: string;
  readonly validationErrors: readonly JsonSchemaValidationError[];
}): string {
  const contract = input.node.output;
  if (contract === undefined) {
    return input.basePromptText;
  }

  const sections = [
    input.basePromptText.trimEnd(),
    "",
    "Output contract:",
    "Return only the business JSON object for output.payload.",
    "Final output.json publication and mailbox delivery are runtime-owned.",
    "Do not write mailbox files, output.json, or invent communication ids.",
    "If you write a file, write only to the reserved Candidate-Path.",
  ];
  if (contract.description !== undefined) {
    sections.push(`Description: ${contract.description}`);
  }
  sections.push(`Candidate-Path: ${input.candidatePath}`);
  if (contract.jsonSchema !== undefined) {
    sections.push("JSON-Schema:");
    sections.push(stableJson(contract.jsonSchema));
  }
  if (input.validationErrors.length > 0) {
    sections.push("Previous output was rejected:");
    formatOutputValidationErrors(input.validationErrors).forEach((entry) => {
      sections.push(`- ${entry.path}: ${entry.message}`);
    });
    if (input.validationErrors.length > MAX_OUTPUT_VALIDATION_FEEDBACK_ERRORS) {
      sections.push(
        `- $: ${input.validationErrors.length - MAX_OUTPUT_VALIDATION_FEEDBACK_ERRORS} additional validation errors omitted; fix the schema violations above first.`,
      );
    }
    sections.push(
      contract.jsonSchema === undefined
        ? "Return a corrected JSON object."
        : "Return a corrected JSON object that satisfies the schema.",
    );
  }
  return sections.join("\n");
}
