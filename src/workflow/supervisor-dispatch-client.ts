import { mkdir } from "node:fs/promises";
import path from "node:path";
import { listWorkflowCatalogSources } from "./catalog";
import { resolveRootDataDir } from "./paths";
import type { LoadOptions } from "./types";
import {
  createRuntimeSupervisorConversationRepository,
  type WorkflowSupervisorConversationRecord,
} from "../events/supervisor-conversations";
import { loadSupervisorProfilesFromEventRoot } from "../events/supervisor-profiles";
import {
  parseSupervisorDispatchProposal,
  validateSupervisorDispatchProposalAgainstContext,
} from "../events/supervisor-dispatch-contract";
import { runSupervisorDispatchLlmResolver } from "../events/supervisor-llm-resolver";
import type { WorkflowTriggerRunnerOptions } from "../events/workflow-trigger-runner-options";

export type { DispatchSupervisorConversationInput } from "./supervisor-dispatch-types";
export type { WorkflowSupervisorDispatchView } from "./supervisor-dispatch-types";
export type { WorkflowSupervisorDispatchClient } from "./supervisor-dispatch-types";
export type { StartManagedWorkflowInput } from "./supervisor-dispatch-types";
export type { SubmitManagedWorkflowInput } from "./supervisor-dispatch-types";
export type { StopManagedWorkflowInput } from "./supervisor-dispatch-types";
export type { SupervisorRuntimeCapabilitySet } from "./supervisor-dispatch-types";

import type {
  DispatchSupervisorConversationInput,
  WorkflowSupervisorDispatchView,
  WorkflowSupervisorDispatchClient,
} from "./supervisor-dispatch-types";

export { supervisorDispatchInProcessCorrelationQueueSize } from "./supervisor-dispatch-helpers";

import {
  withSupervisorDispatchCorrelationQueue,
  nowIso,
  toLightRuns,
  readDispatchLlmIntent,
  assertDispatchBinding,
  assertCorrelationMatchesBinding,
  mergeDispatchLoadOptions,
  mergeTriggerRunnerOptions,
  newSupervisorConversationId,
  newDispatchDecisionId,
  dispatchCorrelationKey,
  buildView,
  insertDecisionRow,
  DISPATCH_CLAIM_PROPOSAL_JSON,
  waitForDispatchDecisionSettled,
  finalizeDispatchDecisionFromProposed,
  normalizeTerminalSubmitProposal,
} from "./supervisor-dispatch-helpers";
export type { WorkflowEngineOverrides } from "./supervisor-dispatch-helpers";

import { applyDispatchProposal } from "./supervisor-dispatch-apply";

export function createWorkflowSupervisorDispatchClient(
  baseOptions: LoadOptions = {},
): WorkflowSupervisorDispatchClient {
  return {
    async dispatchExternalInput(
      input: DispatchSupervisorConversationInput,
    ): Promise<WorkflowSupervisorDispatchView> {
      const mergedLoad = mergeDispatchLoadOptions(baseOptions, input);
      const resolverOptions = mergeTriggerRunnerOptions(mergedLoad, input);
      const sourceId = input.binding.sourceId.trim();
      const bindingId = input.binding.id.trim();
      const correlationKey = input.correlationKey.trim();
      const key = dispatchCorrelationKey({
        sourceId,
        bindingId,
        correlationKey,
      });
      return withSupervisorDispatchCorrelationQueue(key, async () =>
        dispatchExternalInputLocked({
          baseOptions: mergedLoad,
          resolverOptions,
          input,
        }),
      );
    },
  };
}

async function dispatchExternalInputLocked(input: {
  readonly baseOptions: LoadOptions;
  readonly resolverOptions: WorkflowTriggerRunnerOptions;
  readonly input: DispatchSupervisorConversationInput;
}): Promise<WorkflowSupervisorDispatchView> {
  const { baseOptions, resolverOptions, input: req } = input;
  const sourceId = req.binding.sourceId.trim();
  const bindingId = req.binding.id.trim();
  const correlationKey = req.correlationKey.trim();
  assertDispatchBinding(req.binding, req.supervisorProfileId);
  assertCorrelationMatchesBinding(req.binding, req.event, req.correlationKey);

  const catalog = await listWorkflowCatalogSources(baseOptions);
  if (!catalog.ok) {
    throw new Error(catalog.error.message);
  }
  const workflowNames = new Set(
    catalog.value.map((entry) => entry.workflowName),
  );
  const profileLoad = await loadSupervisorProfilesFromEventRoot(
    req.eventRoot,
    workflowNames,
  );
  const profile = profileLoad.profilesById.get(req.supervisorProfileId.trim());
  if (profile === undefined) {
    throw new Error(
      `unknown supervisor profile '${req.supervisorProfileId}' under eventRoot (expected supervisors/*.json)`,
    );
  }

  const repo = createRuntimeSupervisorConversationRepository(baseOptions);
  const rootDataDir = resolveRootDataDir(baseOptions);
  const now = nowIso();

  let conversation =
    (await repo.findConversationByCorrelation({
      sourceId,
      bindingId,
      correlationKey,
    })) ?? null;

  if (conversation === null) {
    const supervisorConversationId = newSupervisorConversationId();
    const artifactDir = path.join(
      rootDataDir,
      "supervisor-conversations",
      supervisorConversationId,
    );
    await mkdir(artifactDir, { recursive: true });
    const row: WorkflowSupervisorConversationRecord = {
      supervisorConversationId,
      supervisorProfileId: profile.supervisorProfileId,
      profileRevision: profile.profileRevision,
      supervisorWorkflowName: profile.supervisorWorkflowName,
      sourceId,
      bindingId,
      correlationKey,
      conversationRevision: 1,
      status: "active",
      artifactDir,
      createdAt: now,
      updatedAt: now,
    };
    const ins = await repo.insertConversation(row);
    if (ins === "duplicate") {
      conversation = await repo.findConversationByCorrelation({
        sourceId,
        bindingId,
        correlationKey,
      });
    } else {
      conversation = row;
    }
  }
  if (conversation === null) {
    throw new Error("failed to resolve supervisor conversation row");
  }
  if (conversation.profileRevision !== profile.profileRevision) {
    throw new Error(
      "supervisor profile revision changed since conversation was created; stop and recreate the conversation",
    );
  }

  const priorDecision = await repo.loadDispatchDecisionBySourceMessage({
    supervisorConversationId: conversation.supervisorConversationId,
    sourceMessageId: req.sourceMessageId,
  });
  if (priorDecision !== null) {
    const settled =
      priorDecision.status === "proposed"
        ? await waitForDispatchDecisionSettled(
            repo,
            conversation.supervisorConversationId,
            req.sourceMessageId,
          )
        : priorDecision;
    const parsed = parseSupervisorDispatchProposal(
      JSON.parse(settled.proposalJson) as unknown,
    );
    if (!parsed.ok) {
      throw new Error(
        `stored dispatch decision proposal is invalid: ${parsed.error}`,
      );
    }
    return buildView(
      repo,
      conversation.supervisorConversationId,
      settled,
      parsed.value,
      settled.status === "applied",
    );
  }

  let managedRuns = await repo.listManagedRuns(
    conversation.supervisorConversationId,
  );

  const decisionId = newDispatchDecisionId();
  const claimTs = nowIso();
  const claimInsert = await insertDecisionRow(repo, {
    decisionId,
    supervisorConversationId: conversation.supervisorConversationId,
    sourceMessageId: req.sourceMessageId,
    profileRevision: profile.profileRevision,
    conversationRevision: conversation.conversationRevision,
    status: "proposed",
    proposalJson: DISPATCH_CLAIM_PROPOSAL_JSON,
    createdAt: claimTs,
    updatedAt: claimTs,
  });
  if (claimInsert === "duplicate") {
    const concurrent = await waitForDispatchDecisionSettled(
      repo,
      conversation.supervisorConversationId,
      req.sourceMessageId,
    );
    const parsedConcurrent = parseSupervisorDispatchProposal(
      JSON.parse(concurrent.proposalJson) as unknown,
    );
    if (!parsedConcurrent.ok) {
      throw new Error(
        `stored dispatch decision proposal is invalid: ${parsedConcurrent.error}`,
      );
    }
    return buildView(
      repo,
      conversation.supervisorConversationId,
      concurrent,
      parsedConcurrent.value,
      concurrent.status === "applied",
    );
  }

  const revisionAtProposal = conversation.conversationRevision;

  try {
    const llmIntent = readDispatchLlmIntent(req.binding);
    const resolverResult = await runSupervisorDispatchLlmResolver({
      binding: req.binding,
      event: req.event,
      ...(req.source === undefined ? {} : { source: req.source }),
      resolverWorkflowName: llmIntent.resolverWorkflowName,
      resolverNodeId: llmIntent.resolverNodeId,
      ...(llmIntent.inputPath === undefined
        ? {}
        : { inputPath: llmIntent.inputPath }),
      profile,
      supervisorConversationId: conversation.supervisorConversationId,
      sourceMessageId: req.sourceMessageId,
      conversationRevision: conversation.conversationRevision,
      managedRuns: toLightRuns(managedRuns),
      options: resolverOptions,
    });

    if (!resolverResult.ok) {
      await finalizeDispatchDecisionFromProposed(repo, {
        decisionId,
        nextStatus: "rejected",
        proposal: {
          action: "clarify",
          reason: resolverResult.error,
          confidence: 1,
        },
        revisionAtProposal,
        profileRevision: profile.profileRevision,
        resultSummaryJson: JSON.stringify({ error: resolverResult.error }),
      });
      throw new Error(resolverResult.error);
    }

    let proposal = normalizeTerminalSubmitProposal(
      resolverResult.proposal,
      profile,
      conversation,
      managedRuns,
    );

    const validationIssues = validateSupervisorDispatchProposalAgainstContext(
      proposal,
      {
        supervisorConversationId: conversation.supervisorConversationId,
        profile,
        sourceMessageId: req.sourceMessageId,
        conversationRevision: conversation.conversationRevision,
        managedRuns: toLightRuns(managedRuns),
        ...(conversation.selectedManagedRunIdsByWorkflowKey === undefined
          ? {}
          : {
              selectedManagedRunIdsByWorkflowKey:
                conversation.selectedManagedRunIdsByWorkflowKey,
            }),
        ...(conversation.selectedManagedRunId === undefined
          ? {}
          : { selectedManagedRunId: conversation.selectedManagedRunId }),
      },
    );

    if (validationIssues.length > 0) {
      await finalizeDispatchDecisionFromProposed(repo, {
        decisionId,
        nextStatus: "rejected",
        proposal,
        revisionAtProposal,
        profileRevision: profile.profileRevision,
        resultSummaryJson: JSON.stringify({ issues: validationIssues }),
      });
      const rejectedRow = await repo.loadDispatchDecisionBySourceMessage({
        supervisorConversationId: conversation.supervisorConversationId,
        sourceMessageId: req.sourceMessageId,
      });
      if (rejectedRow === null) {
        throw new Error("dispatch decision row missing after rejection");
      }
      return buildView(
        repo,
        conversation.supervisorConversationId,
        rejectedRow,
        proposal,
        false,
        validationIssues,
      );
    }

    const applied = await applyDispatchProposal({
      repo,
      baseOptions,
      resolverOptions,
      profile,
      conversation,
      proposal,
      managedRuns,
    });
    conversation = applied.conversation;
    managedRuns = applied.managedRuns;
    proposal = applied.effectiveProposal;

    await finalizeDispatchDecisionFromProposed(repo, {
      decisionId,
      nextStatus: "applied",
      proposal,
      revisionAtProposal,
      profileRevision: profile.profileRevision,
    });
    const appliedRow = await repo.loadDispatchDecisionBySourceMessage({
      supervisorConversationId: conversation.supervisorConversationId,
      sourceMessageId: req.sourceMessageId,
    });
    if (appliedRow === null) {
      throw new Error("dispatch decision row missing after apply");
    }
    return buildView(
      repo,
      conversation.supervisorConversationId,
      appliedRow,
      proposal,
      true,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await finalizeDispatchDecisionFromProposed(repo, {
        decisionId,
        nextStatus: "rejected",
        proposal: {
          action: "clarify",
          reason: msg,
          confidence: 1,
        },
        revisionAtProposal,
        profileRevision: profile.profileRevision,
        resultSummaryJson: JSON.stringify({ error: msg }),
      });
    } catch {
      // Best-effort: claim row may already be finalized or DB unavailable.
    }
    throw err;
  }
}
