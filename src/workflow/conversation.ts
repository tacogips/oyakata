import type { WorkflowSessionState } from "./session";
import { evaluateBranch } from "./semantics";
import type { SubWorkflowRef, WorkflowJson } from "./types";

export interface ConversationTurn {
  readonly conversationId: string;
  readonly turnIndex: number;
  readonly fromSubWorkflowId: string;
  readonly toSubWorkflowId: string;
  readonly outputRef: Readonly<Record<string, unknown>>;
}

export interface ConversationExecutionResult {
  readonly status: "stopped" | "max_turns" | "failed";
  readonly turns: readonly ConversationTurn[];
}

function findSubWorkflow(workflow: WorkflowJson, subWorkflowId: string): SubWorkflowRef | undefined {
  return workflow.subWorkflows.find((entry) => entry.id === subWorkflowId);
}

function findLatestSucceededNodeExecution(
  session: WorkflowSessionState,
  nodeId: string,
): WorkflowSessionState["nodeExecutions"][number] | undefined {
  return [...session.nodeExecutions].reverse().find((entry) => entry.nodeId === nodeId && entry.status === "succeeded");
}

function conversationTurnCount(session: WorkflowSessionState, conversationId: string): number {
  return (session.conversationTurns ?? []).filter((entry) => entry.conversationId === conversationId).length;
}

export async function executeConversationRound(args: {
  readonly workflow: WorkflowJson;
  readonly sessionId: string;
  readonly session: WorkflowSessionState;
}): Promise<ConversationExecutionResult> {
  const conversations = args.workflow.subWorkflowConversations ?? [];
  if (conversations.length === 0) {
    return { status: "stopped", turns: [] };
  }

  for (const conversation of conversations) {
    const participants = [...conversation.participants];
    if (participants.length < 2) {
      return { status: "failed", turns: [] };
    }

    const completedTurns = conversationTurnCount(args.session, conversation.id);
    if (completedTurns >= conversation.maxTurns) {
      continue;
    }

    const senderIndex = completedTurns % participants.length;
    const receiverIndex = (senderIndex + 1) % participants.length;
    const fromSubWorkflowId = participants[senderIndex];
    const toSubWorkflowId = participants[receiverIndex];
    if (fromSubWorkflowId === undefined || toSubWorkflowId === undefined) {
      return { status: "failed", turns: [] };
    }

    const sender = findSubWorkflow(args.workflow, fromSubWorkflowId);
    if (sender === undefined) {
      return { status: "failed", turns: [] };
    }
    const receiver = findSubWorkflow(args.workflow, toSubWorkflowId);
    if (receiver === undefined) {
      return { status: "failed", turns: [] };
    }
    const receiverAlreadyStarted = args.session.nodeExecutions.some((entry) => entry.nodeId === receiver.inputNodeId);
    if (receiverAlreadyStarted) {
      continue;
    }

    const outputExecution = findLatestSucceededNodeExecution(args.session, sender.outputNodeId);
    if (outputExecution === undefined) {
      continue;
    }

    const stopContext: Readonly<Record<string, unknown>> = {
      turns_exhausted: completedTurns >= conversation.maxTurns,
      has_sender_output: true,
      [fromSubWorkflowId]: true,
      [toSubWorkflowId]: true,
    };
    if (conversation.stopWhen.length > 0 && evaluateBranch({ when: conversation.stopWhen, output: stopContext })) {
      return { status: "stopped", turns: [] };
    }

    const turn: ConversationTurn = {
      conversationId: conversation.id,
      turnIndex: completedTurns + 1,
      fromSubWorkflowId,
      toSubWorkflowId,
      outputRef: {
        sessionId: args.sessionId,
        workflowId: args.workflow.workflowId,
        subWorkflowId: fromSubWorkflowId,
        outputNodeId: sender.outputNodeId,
        nodeExecId: outputExecution.nodeExecId,
        artifactDir: outputExecution.artifactDir,
      },
    };

    return {
      status: completedTurns + 1 >= conversation.maxTurns ? "max_turns" : "stopped",
      turns: [turn],
    };
  }

  return { status: "max_turns", turns: [] };
}
