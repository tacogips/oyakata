import { isJsonObject } from "../shared/json";
import type {
  SupervisorChatCommandDecision,
  SupervisorChatDecisionAction,
} from "./supervisor-command-contract";
import type { WorkflowSupervisorProfile } from "./supervisor-profiles";

export type SupervisorDispatchAction =
  | "answer-directly"
  | "start-workflow"
  | "submit-input"
  | "switch-workflow"
  | "stop-workflow"
  | "restart-workflow"
  | "status"
  | "clarify"
  | "no-op";

const DISPATCH_ACTIONS = new Set<string>([
  "answer-directly",
  "start-workflow",
  "submit-input",
  "switch-workflow",
  "stop-workflow",
  "restart-workflow",
  "status",
  "clarify",
  "no-op",
]);

export interface SupervisorDispatchTarget {
  readonly managedWorkflowKey: string;
  readonly managedRunId?: string;
  readonly runAlias?: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface SupervisorDispatchProposal {
  readonly action: SupervisorDispatchAction;
  readonly targets?: readonly SupervisorDispatchTarget[];
  readonly confidence?: number;
  readonly reason: string;
  readonly reply?: Readonly<Record<string, unknown>>;
}

export interface ManagedWorkflowRunRecordLight {
  readonly managedRunId: string;
  readonly supervisorConversationId: string;
  readonly managedWorkflowKey: string;
  readonly runAlias?: string;
  readonly status:
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "completed"
    | "failed";
}

export interface WorkflowSupervisorDispatchContext {
  readonly supervisorConversationId: string;
  readonly profile: WorkflowSupervisorProfile;
  readonly sourceMessageId: string;
  readonly conversationRevision: number;
  readonly managedRuns: readonly ManagedWorkflowRunRecordLight[];
}

function readNonEmptyString(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isDispatchAction(value: unknown): value is SupervisorDispatchAction {
  return typeof value === "string" && DISPATCH_ACTIONS.has(value);
}

function parseDispatchTarget(
  value: unknown,
  index: number,
):
  | { readonly ok: true; readonly value: SupervisorDispatchTarget }
  | { readonly ok: false; readonly error: string } {
  if (!isJsonObject(value)) {
    return {
      ok: false,
      error: `targets[${String(index)}] must be an object`,
    };
  }
  const managedWorkflowKey = readNonEmptyString(value, "managedWorkflowKey");
  if (managedWorkflowKey === undefined) {
    return {
      ok: false,
      error: `targets[${String(index)}].managedWorkflowKey is required`,
    };
  }
  const managedRunId = readNonEmptyString(value, "managedRunId");
  const runAlias = readNonEmptyString(value, "runAlias");
  const inputPayload = value["input"];
  if (
    inputPayload !== undefined &&
    (!isJsonObject(inputPayload) || Array.isArray(inputPayload))
  ) {
    return {
      ok: false,
      error: `targets[${String(index)}].input must be an object when set`,
    };
  }
  return {
    ok: true,
    value: {
      managedWorkflowKey,
      ...(managedRunId === undefined ? {} : { managedRunId }),
      ...(runAlias === undefined ? {} : { runAlias }),
      ...(inputPayload === undefined
        ? {}
        : { input: inputPayload as Readonly<Record<string, unknown>> }),
    },
  };
}

/**
 * Strict structural parse of a dispatcher decision proposal from JSON.
 */
export function parseSupervisorDispatchProposal(
  value: unknown,
):
  | { readonly ok: true; readonly value: SupervisorDispatchProposal }
  | { readonly ok: false; readonly error: string } {
  if (!isJsonObject(value)) {
    return { ok: false, error: "proposal must be a JSON object" };
  }
  const action = value["action"];
  if (!isDispatchAction(action)) {
    return {
      ok: false,
      error: `action must be a supported supervisor dispatch action; got ${JSON.stringify(action)}`,
    };
  }
  const reason = value["reason"];
  if (typeof reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  const confidence = value["confidence"];
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || !Number.isFinite(confidence))
  ) {
    return { ok: false, error: "confidence must be a finite number when set" };
  }
  const targetsRaw = value["targets"];
  let targets: readonly SupervisorDispatchTarget[] | undefined;
  if (targetsRaw !== undefined) {
    if (!Array.isArray(targetsRaw)) {
      return { ok: false, error: "targets must be an array when set" };
    }
    const parsed: SupervisorDispatchTarget[] = [];
    for (let i = 0; i < targetsRaw.length; i += 1) {
      const t = parseDispatchTarget(targetsRaw[i], i);
      if (!t.ok) {
        return t;
      }
      parsed.push(t.value);
    }
    targets = parsed;
  }
  const reply = value["reply"];
  if (reply !== undefined && (!isJsonObject(reply) || Array.isArray(reply))) {
    return { ok: false, error: "reply must be an object when set" };
  }
  return {
    ok: true,
    value: {
      action,
      reason,
      ...(confidence === undefined ? {} : { confidence }),
      ...(targets === undefined ? {} : { targets }),
      ...(reply === undefined
        ? {}
        : { reply: reply as Readonly<Record<string, unknown>> }),
    },
  };
}

const DEFAULT_LLM_MIN_CONFIDENCE = 0.75;

export interface DispatchProposalValidationIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * Deterministic validation of a parsed proposal against a pinned profile and
 * resolver context (managed keys, confidence floor, basic targeting rules).
 */
export function validateSupervisorDispatchProposalAgainstContext(
  proposal: SupervisorDispatchProposal,
  context: WorkflowSupervisorDispatchContext,
): readonly DispatchProposalValidationIssue[] {
  const issues: DispatchProposalValidationIssue[] = [];
  const allowedKeys = new Set(
    context.profile.managedWorkflows.map((m) => m.key),
  );
  const minConfidence =
    context.profile.conversationPolicy?.llmDecisionMinConfidence ??
    DEFAULT_LLM_MIN_CONFIDENCE;
  if (
    proposal.confidence !== undefined &&
    proposal.confidence < minConfidence
  ) {
    issues.push({
      code: "low-confidence",
      message: `confidence ${String(proposal.confidence)} is below minimum ${String(minConfidence)}`,
    });
  }

  const targets = proposal.targets ?? [];
  const seenAlias = new Map<string, string>();
  for (const [i, t] of targets.entries()) {
    if (!allowedKeys.has(t.managedWorkflowKey)) {
      issues.push({
        code: "unknown-managed-key",
        message: `targets[${String(i)}].managedWorkflowKey '${t.managedWorkflowKey}' is not in the supervisor profile`,
      });
    }
    if (t.runAlias !== undefined) {
      const existing = seenAlias.get(t.runAlias);
      if (existing !== undefined && existing !== t.managedWorkflowKey) {
        issues.push({
          code: "duplicate-run-alias",
          message: `duplicate runAlias '${t.runAlias}' across different managed workflow keys`,
        });
      }
      seenAlias.set(t.runAlias, t.managedWorkflowKey);
    }
    if (t.managedRunId !== undefined) {
      const run = context.managedRuns.find((r) => r.managedRunId === t.managedRunId);
      if (run === undefined) {
        issues.push({
          code: "unknown-managed-run",
          message: `targets[${String(i)}].managedRunId does not match an active conversation run`,
        });
      } else if (run.managedWorkflowKey !== t.managedWorkflowKey) {
        issues.push({
          code: "managed-run-key-mismatch",
          message: `targets[${String(i)}].managedWorkflowKey does not match managedRunId`,
        });
      }
    }
  }

  const direct = context.profile.directAnswerPolicy;
  if (proposal.action === "answer-directly") {
    if (direct === undefined || !direct.enabled) {
      issues.push({
        code: "direct-answer-disabled",
        message: "answer-directly is not allowed by the supervisor profile",
      });
    } else if (
      direct.allowedDecisionKinds !== undefined &&
      direct.allowedDecisionKinds.length > 0 &&
      !direct.allowedDecisionKinds.includes("answer-directly")
    ) {
      issues.push({
        code: "direct-answer-kind-blocked",
        message: "answer-directly is not listed in directAnswerPolicy.allowedDecisionKinds",
      });
    }
  }

  if (proposal.action === "status") {
    if (direct !== undefined && direct.enabled === true) {
      if (
        direct.allowedDecisionKinds !== undefined &&
        direct.allowedDecisionKinds.length > 0 &&
        !direct.allowedDecisionKinds.includes("status")
      ) {
        issues.push({
          code: "status-kind-blocked",
          message: "status is not listed in directAnswerPolicy.allowedDecisionKinds",
        });
      }
    }
  }

  return issues;
}

/**
 * When confidence is too low or the proposal is structurally unusable, normalize
 * to a safe clarification proposal (runtime still records the original).
 */
export function fallbackSupervisorDispatchProposalForLowConfidence(
  reason: string,
): SupervisorDispatchProposal {
  return {
    action: "clarify",
    reason,
    confidence: 1,
  };
}

const CHAT_TO_DISPATCH: Readonly<
  Record<SupervisorChatDecisionAction, SupervisorDispatchAction>
> = {
  ignore: "no-op",
  start: "start-workflow",
  stop: "stop-workflow",
  restart: "restart-workflow",
  status: "status",
  input: "submit-input",
};

/**
 * Maps a single-target supervised chat decision into the dispatcher proposal
 * vocabulary (managed workflow key is taken from {@link SupervisorChatCommandDecision.managedWorkflowName}).
 */
export function mapSupervisorChatDecisionToDispatchProposal(
  decision: SupervisorChatCommandDecision,
): SupervisorDispatchProposal {
  const action = CHAT_TO_DISPATCH[decision.action];
  const key = decision.managedWorkflowName;
  const needsTarget =
    action === "start-workflow" ||
    action === "stop-workflow" ||
    action === "restart-workflow" ||
    action === "submit-input";
  return {
    action,
    reason: decision.reason,
    confidence: decision.confidence,
    ...(needsTarget
      ? {
          targets: [
            {
              managedWorkflowKey: key,
              ...(decision.runtimeVariables === undefined
                ? {}
                : { input: decision.runtimeVariables }),
            },
          ],
        }
      : {}),
  };
}
