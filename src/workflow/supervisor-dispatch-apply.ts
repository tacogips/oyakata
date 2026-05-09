import { runWorkflow } from "./engine";
import { withResolvedWorkflowSourceOptions } from "./catalog";
import { loadWorkflowFromCatalog } from "./load";
import { saveSession, loadSession } from "./session-store";
import type { WorkflowSessionState } from "./session";
import {
  getNormalizedNodePayload,
  resolveWorkflowManagerStepId,
  type LoadOptions,
} from "./types";
import type {
  ManagedWorkflowRunRecord,
  WorkflowSupervisorConversationRecord,
  WorkflowSupervisorConversationRepository,
} from "../events/supervisor-conversations";
import type {
  ManagedWorkflowDefinition,
  WorkflowSupervisorProfile,
} from "../events/supervisor-profiles";
import type {
  SupervisorDispatchProposal,
  SupervisorDispatchTarget,
} from "../events/supervisor-dispatch-contract";
import type { WorkflowTriggerRunnerOptions } from "../events/workflow-trigger-runner-options";
import {
  nowIso,
  cancelTargetSession,
  persistStoppedManagedRun,
  dedupeNodeIds,
  resolveWorkflowOptionsForName,
  startManagedWorkflowRun,
  lookupManagedWorkflowDefinition,
  findRunForTarget,
  primaryTarget,
  type WorkflowEngineOverrides,
} from "./supervisor-dispatch-helpers";

export async function applyDispatchProposal(input: {
  readonly repo: WorkflowSupervisorConversationRepository;
  readonly baseOptions: LoadOptions;
  readonly resolverOptions: WorkflowTriggerRunnerOptions;
  readonly profile: WorkflowSupervisorProfile;
  readonly conversation: WorkflowSupervisorConversationRecord;
  readonly proposal: SupervisorDispatchProposal;
  readonly managedRuns: readonly ManagedWorkflowRunRecord[];
}): Promise<{
  readonly conversation: WorkflowSupervisorConversationRecord;
  readonly managedRuns: readonly ManagedWorkflowRunRecord[];
  readonly effectiveProposal: SupervisorDispatchProposal;
}> {
  const { repo, baseOptions, resolverOptions, profile } = input;
  let conversation = input.conversation;
  let managedRuns = [...input.managedRuns];
  const proposal = input.proposal;

  const bumpConversation = async (
    patch: Partial<WorkflowSupervisorConversationRecord>,
  ): Promise<void> => {
    const next: WorkflowSupervisorConversationRecord = {
      ...conversation,
      ...patch,
      conversationRevision: conversation.conversationRevision + 1,
      updatedAt: nowIso(),
    };
    const updated = await repo.updateConversationCas({
      expectedConversationRevision: conversation.conversationRevision,
      next,
    });
    if (updated === null) {
      throw new Error(
        "supervisor conversation changed concurrently; retry dispatch",
      );
    }
    conversation = updated;
    managedRuns = [
      ...(await repo.listManagedRuns(conversation.supervisorConversationId)),
    ];
  };

  const engineOverrides: WorkflowEngineOverrides = {
    ...(resolverOptions.mockScenario === undefined
      ? {}
      : { mockScenario: resolverOptions.mockScenario }),
    ...(resolverOptions.dryRun === undefined
      ? {}
      : { dryRun: resolverOptions.dryRun }),
    ...(resolverOptions.maxSteps === undefined
      ? {}
      : { maxSteps: resolverOptions.maxSteps }),
    ...(resolverOptions.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: resolverOptions.maxLoopIterations }),
    ...(resolverOptions.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: resolverOptions.defaultTimeoutMs }),
  };

  switch (proposal.action) {
    case "no-op":
    case "clarify":
    case "answer-directly":
    case "status": {
      await bumpConversation({});
      return { conversation, managedRuns, effectiveProposal: proposal };
    }
    case "switch-workflow": {
      const target = primaryTarget(proposal);
      if (target === undefined) {
        throw new Error("switch-workflow requires at least one target");
      }
      const def = lookupManagedWorkflowDefinition(
        profile,
        target.managedWorkflowKey,
      );
      if (def === undefined) {
        throw new Error(
          `unknown managed workflow key '${target.managedWorkflowKey}'`,
        );
      }

      const maybeStopPreviousSelectedRunForSwitch = async (
        nextPrimaryManagedRunId: string | undefined,
      ): Promise<void> => {
        const prevId = conversation.selectedManagedRunId;
        if (prevId === undefined) {
          return;
        }
        if (
          nextPrimaryManagedRunId !== undefined &&
          prevId === nextPrimaryManagedRunId
        ) {
          return;
        }
        const prevRun = managedRuns.find((r) => r.managedRunId === prevId);
        if (prevRun === undefined) {
          return;
        }
        const prevDef = lookupManagedWorkflowDefinition(
          profile,
          prevRun.managedWorkflowKey,
        );
        if (prevDef?.lifecycle?.stopOnSwitch !== true) {
          return;
        }
        await persistStoppedManagedRun(repo, prevRun, baseOptions);
        managedRuns = [
          ...(await repo.listManagedRuns(
            conversation.supervisorConversationId,
          )),
        ];
      };

      const applySwitchSelection = async (
        run: ManagedWorkflowRunRecord,
      ): Promise<{
        readonly conversation: WorkflowSupervisorConversationRecord;
        readonly managedRuns: readonly ManagedWorkflowRunRecord[];
        readonly effectiveProposal: SupervisorDispatchProposal;
      }> => {
        await maybeStopPreviousSelectedRunForSwitch(run.managedRunId);
        const nextSel: Record<string, string> = {
          ...(conversation.selectedManagedRunIdsByWorkflowKey ?? {}),
          [run.managedWorkflowKey]: run.managedRunId,
        };
        await bumpConversation({
          selectedManagedRunIdsByWorkflowKey: nextSel,
          selectedManagedRunId: run.managedRunId,
        });
        return { conversation, managedRuns, effectiveProposal: proposal };
      };

      const explicitRunId = target.managedRunId?.trim();
      if (explicitRunId !== undefined && explicitRunId.length > 0) {
        const run = managedRuns.find((r) => r.managedRunId === explicitRunId);
        if (run === undefined) {
          throw new Error("switch-workflow target run not found");
        }
        if (run.managedWorkflowKey !== target.managedWorkflowKey) {
          throw new Error("switch-workflow managedRunId key mismatch");
        }
        return await applySwitchSelection(run);
      }

      if (def.lifecycle?.startOnSwitch !== true) {
        throw new Error(
          "switch-workflow requires a target with managedRunId unless the managed workflow enables lifecycle.startOnSwitch",
        );
      }

      const key = def.key;
      const activeForSwitch = managedRuns.filter(
        (r) =>
          r.managedWorkflowKey === key &&
          (r.status === "running" || r.status === "starting"),
      );
      if (activeForSwitch.length > 1) {
        throw new Error(
          "switch-workflow without managedRunId is ambiguous when multiple active runs exist for the key",
        );
      }
      if (activeForSwitch.length === 1) {
        const activeRun = activeForSwitch[0];
        if (activeRun !== undefined) {
          return await applySwitchSelection(activeRun);
        }
      }

      enforceConcurrencyForStart(def, managedRuns, target);
      const startedRun = await startManagedWorkflowRun({
        repo,
        conversation,
        def,
        target,
        baseOptions,
        engineOverrides,
      });
      const managedRunId = startedRun.managedRunId;
      managedRuns = [...startedRun.managedRuns];
      await maybeStopPreviousSelectedRunForSwitch(managedRunId);

      const nextSel: Record<string, string> = {
        ...(conversation.selectedManagedRunIdsByWorkflowKey ?? {}),
        [def.key]: managedRunId,
      };
      await bumpConversation({
        selectedManagedRunIdsByWorkflowKey: nextSel,
        selectedManagedRunId: managedRunId,
      });
      return { conversation, managedRuns, effectiveProposal: proposal };
    }
    case "stop-workflow": {
      const target = primaryTarget(proposal);
      const run = findRunForTarget(target, managedRuns, conversation);
      if (run === undefined) {
        throw new Error(
          "stop-workflow requires a resolvable managed run target",
        );
      }
      await persistStoppedManagedRun(repo, run, baseOptions);
      await bumpConversation({});
      return { conversation, managedRuns, effectiveProposal: proposal };
    }
    case "restart-workflow": {
      const target = primaryTarget(proposal);
      const run = findRunForTarget(target, managedRuns, conversation);
      if (run === undefined) {
        throw new Error(
          "restart-workflow requires a resolvable managed run target",
        );
      }
      const def = lookupManagedWorkflowDefinition(
        profile,
        run.managedWorkflowKey,
      );
      if (def === undefined) {
        throw new Error("unknown managed workflow key for restart");
      }
      if (run.activeTargetExecutionId !== undefined) {
        await cancelTargetSession(run.activeTargetExecutionId, baseOptions);
      }
      const wfOptions = await resolveWorkflowOptionsForName(
        def.workflowName,
        baseOptions,
      );
      const started = await runWorkflow(def.workflowName, {
        ...wfOptions,
        ...engineOverrides,
      });
      if (!started.ok) {
        throw new Error(started.error.message);
      }
      const restarted: ManagedWorkflowRunRecord = {
        ...run,
        status: "running",
        activeTargetExecutionId: started.value.session.sessionId,
        restartCount: run.restartCount + 1,
        updatedAt: nowIso(),
      };
      await repo.upsertManagedRun(restarted);
      await bumpConversation({});
      return { conversation, managedRuns, effectiveProposal: proposal };
    }
    case "start-workflow": {
      const target = primaryTarget(proposal);
      if (target === undefined) {
        throw new Error("start-workflow requires at least one target");
      }
      const def = lookupManagedWorkflowDefinition(
        profile,
        target.managedWorkflowKey,
      );
      if (def === undefined) {
        throw new Error(
          `unknown managed workflow key '${target.managedWorkflowKey}'`,
        );
      }
      enforceConcurrencyForStart(def, managedRuns, target);
      const startedRun = await startManagedWorkflowRun({
        repo,
        conversation,
        def,
        target,
        baseOptions,
        engineOverrides,
      });
      const managedRunId = startedRun.managedRunId;
      managedRuns = [...startedRun.managedRuns];

      const mode = def.concurrency?.mode ?? "multiple-active";
      const nextSel: Record<string, string> = {
        ...(conversation.selectedManagedRunIdsByWorkflowKey ?? {}),
        [def.key]: managedRunId,
      };
      await bumpConversation({
        ...(mode === "single-selected" || mode === "single-active"
          ? {
              selectedManagedRunIdsByWorkflowKey: nextSel,
              selectedManagedRunId: managedRunId,
            }
          : {}),
      });
      return { conversation, managedRuns, effectiveProposal: proposal };
    }
    case "submit-input": {
      const target = primaryTarget(proposal);
      const run = findRunForTarget(target, managedRuns, conversation);
      if (run === undefined) {
        throw new Error(
          "submit-input requires a resolvable managed run target",
        );
      }
      if (run.activeTargetExecutionId === undefined) {
        throw new Error(
          "submit-input requires a managed run with an active target session",
        );
      }
      const def = lookupManagedWorkflowDefinition(
        profile,
        run.managedWorkflowKey,
      );
      if (def === undefined) {
        throw new Error("unknown managed workflow key for submit-input");
      }
      const loadedWf = await loadWorkflowFromCatalog(
        run.targetWorkflowName,
        baseOptions,
      );
      if (!loadedWf.ok) {
        throw new Error(loadedWf.error.message);
      }
      const managerStepId = resolveWorkflowManagerStepId(
        loadedWf.value.bundle.workflow,
      );
      const managerNode = getNormalizedNodePayload(
        loadedWf.value.bundle,
        managerStepId,
      );
      const sessionId = run.activeTargetExecutionId;
      const existing = await loadSession(sessionId, baseOptions);
      if (!existing.ok) {
        throw new Error(existing.error.message);
      }
      const wfBase =
        loadedWf.value.source === undefined
          ? baseOptions
          : withResolvedWorkflowSourceOptions(
              loadedWf.value.source,
              baseOptions,
            );
      const runVars = target?.input ?? {};
      if (managerNode?.sessionPolicy?.mode === "reuse") {
        const { endedAt: _e, lastError: _l, ...resumable } = existing.value;
        const merged: WorkflowSessionState = {
          ...resumable,
          status: "running",
          queue: dedupeNodeIds([managerStepId, ...existing.value.queue]),
          currentNodeId: managerStepId,
          runtimeVariables: {
            ...existing.value.runtimeVariables,
            ...runVars,
          },
        };
        const saved = await saveSession(merged, baseOptions);
        if (!saved.ok) {
          throw new Error(saved.error.message);
        }
        const runAgain = await runWorkflow(run.targetWorkflowName, {
          ...wfBase,
          resumeSessionId: merged.sessionId,
          ...engineOverrides,
        });
        if (!runAgain.ok) {
          throw new Error(runAgain.error.message);
        }
        const nextRecord: ManagedWorkflowRunRecord = {
          ...run,
          activeTargetExecutionId: runAgain.value.session.sessionId,
          updatedAt: nowIso(),
        };
        await repo.upsertManagedRun(nextRecord);
      } else {
        const resumed = await runWorkflow(run.targetWorkflowName, {
          ...wfBase,
          resumeSessionId: sessionId,
          ...engineOverrides,
          ...(Object.keys(runVars).length === 0
            ? {}
            : { runtimeVariables: runVars }),
        });
        if (!resumed.ok) {
          throw new Error(resumed.error.message);
        }
        const nextRecord: ManagedWorkflowRunRecord = {
          ...run,
          activeTargetExecutionId: resumed.value.session.sessionId,
          updatedAt: nowIso(),
        };
        await repo.upsertManagedRun(nextRecord);
      }
      await bumpConversation({});
      return { conversation, managedRuns, effectiveProposal: proposal };
    }
    default: {
      throw new Error(
        `dispatch action '${proposal.action}' is not supported by the runtime client yet`,
      );
    }
  }
}

export function enforceConcurrencyForStart(
  def: ManagedWorkflowDefinition,
  runs: readonly ManagedWorkflowRunRecord[],
  target: SupervisorDispatchTarget,
): void {
  const mode = def.concurrency?.mode ?? "multiple-active";
  if (mode === "multiple-active") {
    return;
  }
  const activeForKey = runs.filter(
    (r) =>
      r.managedWorkflowKey === def.key &&
      (r.status === "running" ||
        r.status === "starting" ||
        r.status === "stopping"),
  );
  if (mode === "single-active" && activeForKey.length > 0) {
    throw new Error(
      `managed workflow '${def.key}' is single-active and already has an active run`,
    );
  }
  if (mode === "single-selected" && activeForKey.length > 0) {
    throw new Error(
      `managed workflow '${def.key}' is single-selected and already has an active run`,
    );
  }
  if (def.concurrency?.requiresAliasForParallelRuns === true) {
    const alias = target.runAlias?.trim();
    if (alias === undefined || alias.length === 0) {
      const parallelPeers = runs.filter(
        (r) =>
          r.managedWorkflowKey === def.key &&
          r.runAlias !== undefined &&
          r.runAlias.trim().length > 0,
      );
      if (parallelPeers.length > 0) {
        throw new Error(
          `managed workflow '${def.key}' requires runAlias for parallel runs`,
        );
      }
    }
  }
}
