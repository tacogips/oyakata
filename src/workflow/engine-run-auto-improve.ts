import { randomBytes } from "node:crypto";
import {
  loadWorkflowFromDisk,
  mergeLoadOptionsForSessionMutableBundle,
} from "./load";
import { resolveEffectiveRoots } from "./paths";
import { recordWorkflowPatchRevision } from "./mutable-workspace";
import {
  getEngineSupervisionPatcherId,
  isSupervisionStallLastError,
  planSupervisionRemediation,
} from "./superviser";
import type { NodeAdapter } from "./adapter";
import { loadSession, saveSession } from "./session-store";
import {
  err,
  ok,
  workflowRunFailure,
  type EngineExecutionGuards,
  type RunWorkflowInternalFn,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./engine-types";
import { nowIso } from "./engine-utils";
import type { Result } from "./result";
import type { WorkflowSessionState } from "./session";
import type {
  SupervisionIncident,
  SupervisionRemediationRecord,
} from "./types-auto-improve";

export async function runAutoImproveLoop(
  workflowName: string,
  options: WorkflowRunOptions,
  adapter: NodeAdapter | undefined,
  guards: EngineExecutionGuards | undefined,
  runWorkflowInternalFn: RunWorkflowInternalFn,
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> {
  const policy = options.autoImprove;
  if (policy === undefined) {
    return err(workflowRunFailure(1, "internal: autoImprove policy missing"));
  }
  const innerBase: WorkflowRunOptions = {
    ...options,
    supervisionLoopExecution: true,
  };
  let current: WorkflowRunOptions = innerBase;

  for (;;) {
    const result = await runWorkflowInternalFn(
      workflowName,
      current,
      adapter,
      guards,
      [],
    );

    if (result.ok) {
      const persisted = await loadSession(
        result.value.session.sessionId,
        options,
      );
      const latest = persisted.ok ? persisted.value : result.value.session;
      if (latest.status !== "completed" || result.value.exitCode !== 0) {
        return ok({ ...result.value, session: latest });
      }
      if (latest.supervision !== undefined) {
        const next: WorkflowSessionState = {
          ...latest,
          supervision: { ...latest.supervision, status: "succeeded" },
        };
        const saved = await saveSession(next, options);
        if (!saved.ok) {
          return err(workflowRunFailure(1, saved.error.message, next));
        }
        return ok({ session: next, exitCode: 0 });
      }
      return ok({ ...result.value, session: latest });
    }

    const failure = result.error;
    if (failure.sessionId === undefined) {
      return result;
    }
    if (failure.exitCode === 130) {
      return result;
    }

    const loaded = await loadSession(failure.sessionId, options);
    if (!loaded.ok) {
      return result;
    }
    const failedSession = loaded.value;
    if (failedSession.supervision === undefined) {
      return result;
    }

    const sup = failedSession.supervision;
    if (sup.attemptCount >= policy.maxSupervisedAttempts) {
      const t = nowIso();
      const lastErr = failedSession.lastError;
      const terminalIncident: SupervisionIncident = {
        incidentId: `inc-${randomBytes(6).toString("hex")}`,
        supervisedAttemptId: failedSession.sessionId,
        category: isSupervisionStallLastError(lastErr) ? "stall" : "failure",
        summary: lastErr ?? failure.message,
        detectedAt: t,
      };
      const budgetIncident: SupervisionIncident = {
        incidentId: `inc-${randomBytes(6).toString("hex")}`,
        supervisedAttemptId: failedSession.sessionId,
        category: "budget-exhausted",
        summary: `max supervised attempts (${policy.maxSupervisedAttempts}) reached`,
        detectedAt: t,
      };
      const remediation: SupervisionRemediationRecord = {
        remediationId: `rem-${randomBytes(6).toString("hex")}`,
        incidentId: budgetIncident.incidentId,
        decidedAt: t,
        action: "stop-supervision",
        reason: "supervision attempt budget exhausted",
      };
      const nextSession: WorkflowSessionState = {
        ...failedSession,
        supervision: {
          ...sup,
          status: "stopped",
          incidents: [...sup.incidents, terminalIncident, budgetIncident],
          remediations: [...(sup.remediations ?? []), remediation],
        },
      };
      const saved = await saveSession(nextSession, options);
      if (!saved.ok) {
        return err(workflowRunFailure(1, saved.error.message, nextSession));
      }
      return err(
        workflowRunFailure(
          1,
          nextSession.lastError ?? failure.message,
          nextSession,
        ),
      );
    }

    const t = nowIso();
    const lastErr = failedSession.lastError;
    const failIncident: SupervisionIncident = {
      incidentId: `inc-${randomBytes(6).toString("hex")}`,
      supervisedAttemptId: failedSession.sessionId,
      category: isSupervisionStallLastError(lastErr) ? "stall" : "failure",
      summary: lastErr ?? failure.message,
      detectedAt: t,
    };
    const nextAttempt = sup.attemptCount + 1;

    const loadOptsForTarget = mergeLoadOptionsForSessionMutableBundle(
      options,
      failedSession,
    );
    const wfForTarget = await loadWorkflowFromDisk(
      workflowName,
      loadOptsForTarget,
    );
    if (!wfForTarget.ok) {
      return err(
        workflowRunFailure(
          2,
          `supervision rerun: load workflow: ${wfForTarget.error.message}`,
          failedSession,
        ),
      );
    }
    const targetWorkflow = wfForTarget.value.bundle.workflow;
    const workflowForSupervision = targetWorkflow;
    const remediationPlan = planSupervisionRemediation({
      policy,
      sup,
      workflow: workflowForSupervision,
      session: failedSession,
      failIncident,
    });

    if (remediationPlan.kind === "stop-patch-budget") {
      const tStop = nowIso();
      const patchBudgetIncident: SupervisionIncident = {
        incidentId: `inc-${randomBytes(6).toString("hex")}`,
        supervisedAttemptId: failedSession.sessionId,
        category: "budget-exhausted",
        summary: `max workflow patches (${policy.maxWorkflowPatches}) reached; repeated supervised incident: ${lastErr ?? failure.message}`,
        detectedAt: tStop,
      };
      const patchStopRemediation: SupervisionRemediationRecord = {
        remediationId: `rem-${randomBytes(6).toString("hex")}`,
        incidentId: patchBudgetIncident.incidentId,
        decidedAt: tStop,
        action: "stop-supervision",
        reason: "workflow patch budget exhausted",
      };
      const nextSession: WorkflowSessionState = {
        ...failedSession,
        supervision: {
          ...sup,
          status: "stopped",
          incidents: [...sup.incidents, failIncident, patchBudgetIncident],
          remediations: [...(sup.remediations ?? []), patchStopRemediation],
        },
      };
      const savedP = await saveSession(nextSession, options);
      if (!savedP.ok) {
        return err(workflowRunFailure(1, savedP.error.message, nextSession));
      }
      return err(
        workflowRunFailure(
          1,
          nextSession.lastError ?? failure.message,
          nextSession,
        ),
      );
    }

    let nextPatchCount = sup.workflowPatchCount;
    if (remediationPlan.kind === "patch-then-rerun") {
      const roots = resolveEffectiveRoots(current);
      if (sup.mutableWorkflowDir === undefined) {
        return err(
          workflowRunFailure(
            2,
            "supervision: mutable workflow directory missing; cannot record patch revision",
            failedSession,
          ),
        );
      }
      const patchRec = await recordWorkflowPatchRevision({
        artifactRoot: roots.artifactRoot,
        supervisionRunId: sup.supervisionRunId,
        mutableWorkflowDir: sup.mutableWorkflowDir,
        reason: remediationPlan.patchRecordReason,
        patchedByStepId: getEngineSupervisionPatcherId(),
      });
      if (!patchRec.ok) {
        return err(
          workflowRunFailure(
            2,
            `supervision: ${patchRec.error.message}`,
            failedSession,
          ),
        );
      }
      nextPatchCount += 1;
    }

    const rem: SupervisionRemediationRecord = {
      remediationId: `rem-${randomBytes(6).toString("hex")}`,
      incidentId: failIncident.incidentId,
      decidedAt: t,
      action:
        remediationPlan.kind === "patch-then-rerun"
          ? "patch-workflow"
          : remediationPlan.remediationAction,
      reason:
        remediationPlan.kind === "patch-then-rerun"
          ? remediationPlan.patchRecordReason
          : "automatic target workflow rerun after terminal failure or stall",
      ...(remediationPlan.targetStepId === undefined
        ? {}
        : { targetStepId: remediationPlan.targetStepId }),
    };
    const withUpdates: WorkflowSessionState = {
      ...failedSession,
      supervision: {
        ...sup,
        attemptCount: nextAttempt,
        workflowPatchCount: nextPatchCount,
        incidents: [...sup.incidents, failIncident],
        remediations: [...(sup.remediations ?? []), rem],
        ...(sup.policy === undefined ? { policy } : {}),
      },
    };
    const saved2 = await saveSession(withUpdates, options);
    if (!saved2.ok) {
      return err(workflowRunFailure(1, saved2.error.message, withUpdates));
    }

    const {
      resumeSessionId: _resumeSessionId,
      rerunFromSessionId: _rerunFromSessionId,
      rerunFromStepId: _rerunFromStepId,
      ...rerunBase
    } = innerBase;
    current = {
      ...rerunBase,
      autoImprove: policy,
      supervisionLoopExecution: true,
      rerunFromSessionId: withUpdates.sessionId,
      rerunFromStepId:
        remediationPlan.targetStepId ?? remediationPlan.rerunFromStepId,
    };
  }
}
