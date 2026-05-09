import type { CommunicationLookupInput } from "../workflow/communication-service";
import type {
  CommunicationConnection,
  CommunicationsQueryInput,
  CancelWorkflowExecutionInput,
  CancelWorkflowExecutionPayload,
  ContinueWorkflowExecutionInput,
  ContinueWorkflowExecutionPayload,
  CreateWorkflowDefinitionInput,
  DispatchSupervisedWorkflowCommandInput,
  DispatchSupervisorChatGraphqlInput,
  DispatchSupervisorChatPayload,
  DispatchSupervisorConversationGraphqlInput,
  DispatchSupervisorConversationPayload,
  ExecuteWorkflowInput,
  ExecuteWorkflowPayload,
  GraphqlRequestContext,
  GraphqlSchema,
  GraphqlSchemaDependencies,
  ManagerSessionLookupInput,
  ManagerSessionView,
  NodeExecutionLookupInput,
  NodeExecutionView,
  ReplayCommunicationInput,
  ReplayCommunicationPayload,
  RerunWorkflowExecutionInput,
  RerunWorkflowExecutionPayload,
  ResumeWorkflowExecutionInput,
  ResumeWorkflowExecutionPayload,
  RetryCommunicationDeliveryInput,
  RetryCommunicationDeliveryPayload,
  SaveWorkflowDefinitionInput,
  SaveWorkflowDefinitionPayload,
  SendManagerMessageInput,
  SendManagerMessagePayload,
  SupervisedWorkflowGraphqlPayload,
  SupervisedWorkflowLookupGraphqlInput,
  SupervisorDispatchConversationGraphqlPayload,
  SupervisorDispatchConversationLookupGraphqlInput,
  ValidateWorkflowDefinitionInput,
  ValidateWorkflowDefinitionPayload,
  WorkflowCatalogOverviewGraphqlInput,
  WorkflowDefinitionLookupInput,
  WorkflowDefinitionView,
  WorkflowDefinitionsView,
  WorkflowExecutionConnection,
  WorkflowExecutionLookupInput,
  WorkflowExecutionOverviewLookupInput,
  WorkflowExecutionOverviewView,
  WorkflowExecutionStepRunsPayload,
  WorkflowExecutionStepRunsQueryInput,
  WorkflowExecutionView,
  WorkflowExecutionsQueryInput,
  WorkflowLookupInput,
  WorkflowStatusOverviewGraphqlInput,
  WorkflowView,
} from "./types";
import type {
  ReplayCommunicationInput as ServiceReplayCommunicationInput,
  RetryCommunicationDeliveryInput as ServiceRetryCommunicationInput,
} from "../workflow/communication-service";
import type { SendManagerMessageInput as ServiceSendManagerMessageInput } from "../workflow/manager-message-service";
import type {
  WorkflowCatalogOverview,
  WorkflowStatusOverview,
} from "../workflow/overview";
import {
  resolveManagerStore,
  resolveCommunicationService,
  resolveManagerMessageService,
} from "./schema-helpers";
import {
  listWorkflowDefinitionNames,
  buildWorkflowDefinitionView,
  buildWorkflowView,
  workflowCatalogOverviewQuery,
  workflowStatusOverviewQuery,
  createWorkflowDefinitionMutation,
  saveWorkflowDefinitionMutation,
  validateWorkflowDefinitionMutation,
} from "./schema-workflow-definitions";
import {
  authenticateManagerScope,
  assertWorkflowExecutionScope,
  assertManagerIdentity,
  buildNodeExecutionView,
  buildWorkflowExecutionConnection,
  buildWorkflowExecutionView,
  buildWorkflowExecutionOverviewView,
  buildCommunicationConnection,
  loadScopedCommunicationForManagerMutation,
} from "./schema-execution-views";
import {
  executeWorkflowMutation,
  resumeWorkflowExecutionMutation,
  rerunWorkflowExecutionMutation,
  workflowExecutionStepRunsQuery,
  continueWorkflowExecutionMutation,
} from "./schema-execution-mutations";
import {
  supervisedWorkflowRunQuery,
  supervisorDispatchConversationQuery,
  dispatchSupervisedWorkflowCommandMutation,
  dispatchSupervisorChatMutation,
  dispatchSupervisorConversationMutation,
  cancelWorkflowExecutionMutation,
} from "./schema-supervisor";

export function createGraphqlSchema(
  deps: GraphqlSchemaDependencies = {},
): GraphqlSchema {
  const managerLookupInput = (
    managerSessionId: string | undefined,
  ): ManagerSessionLookupInput =>
    managerSessionId === undefined ? {} : { managerSessionId };

  return {
    query: {
      async workflows(
        _input: Record<string, never> = {},
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowDefinitionsView> {
        return listWorkflowDefinitionNames(context);
      },

      async workflow(
        input: WorkflowLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowView | null> {
        return buildWorkflowView(input, context);
      },

      async workflowDefinition(
        input: WorkflowDefinitionLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowDefinitionView | null> {
        return buildWorkflowDefinitionView(input.workflowName, context);
      },

      async workflowExecution(
        input: WorkflowExecutionLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowExecutionView | null> {
        return buildWorkflowExecutionView(input, context);
      },

      async workflowExecutionOverview(
        input: WorkflowExecutionOverviewLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowExecutionOverviewView | null> {
        return buildWorkflowExecutionOverviewView(input, context, deps);
      },

      async workflowExecutions(
        input: WorkflowExecutionsQueryInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowExecutionConnection> {
        return buildWorkflowExecutionConnection(input, context);
      },

      async workflowCatalogOverview(
        input: WorkflowCatalogOverviewGraphqlInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowCatalogOverview> {
        return workflowCatalogOverviewQuery(input, context);
      },

      async workflowStatusOverview(
        input: WorkflowStatusOverviewGraphqlInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowStatusOverview | null> {
        return workflowStatusOverviewQuery(input, context);
      },

      async communications(
        input: CommunicationsQueryInput,
        context: GraphqlRequestContext = {},
      ): Promise<CommunicationConnection> {
        return buildCommunicationConnection(input, context, deps);
      },

      async communication(
        input: CommunicationLookupInput,
        context: GraphqlRequestContext = {},
      ) {
        return resolveCommunicationService(context, deps).getCommunication(
          input,
          context,
        );
      },

      async nodeExecution(
        input: NodeExecutionLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<NodeExecutionView | null> {
        return buildNodeExecutionView(input, context);
      },

      async managerSession(
        input: ManagerSessionLookupInput,
        context: GraphqlRequestContext = {},
      ): Promise<ManagerSessionView | null> {
        const scope = await authenticateManagerScope(input, context, deps);
        const managerStore = resolveManagerStore(context, deps);
        const messages = await managerStore.listMessages(
          scope.session.managerSessionId,
        );
        return {
          session: scope.session,
          messages,
        };
      },

      async supervisedWorkflowRun(
        input: SupervisedWorkflowLookupGraphqlInput,
        context: GraphqlRequestContext = {},
      ): Promise<SupervisedWorkflowGraphqlPayload> {
        return supervisedWorkflowRunQuery(input, context);
      },

      async supervisorDispatchConversation(
        input: SupervisorDispatchConversationLookupGraphqlInput,
        context: GraphqlRequestContext = {},
      ): Promise<SupervisorDispatchConversationGraphqlPayload> {
        return supervisorDispatchConversationQuery(input, context);
      },

      async workflowExecutionStepRuns(
        input: WorkflowExecutionStepRunsQueryInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowExecutionStepRunsPayload> {
        return workflowExecutionStepRunsQuery(input, context);
      },
    },

    mutation: {
      async createWorkflowDefinition(
        input: CreateWorkflowDefinitionInput,
        context: GraphqlRequestContext = {},
      ): Promise<WorkflowDefinitionView> {
        return createWorkflowDefinitionMutation(input, context);
      },

      async saveWorkflowDefinition(
        input: SaveWorkflowDefinitionInput,
        context: GraphqlRequestContext = {},
      ): Promise<SaveWorkflowDefinitionPayload> {
        return saveWorkflowDefinitionMutation(input, context);
      },

      async validateWorkflowDefinition(
        input: ValidateWorkflowDefinitionInput,
        context: GraphqlRequestContext = {},
      ): Promise<ValidateWorkflowDefinitionPayload> {
        return validateWorkflowDefinitionMutation(input, context);
      },

      async executeWorkflow(
        input: ExecuteWorkflowInput,
        context: GraphqlRequestContext = {},
      ): Promise<ExecuteWorkflowPayload> {
        return executeWorkflowMutation(input, context);
      },

      async resumeWorkflowExecution(
        input: ResumeWorkflowExecutionInput,
        context: GraphqlRequestContext = {},
      ): Promise<ResumeWorkflowExecutionPayload> {
        return resumeWorkflowExecutionMutation(input, context);
      },

      async rerunWorkflowExecution(
        input: RerunWorkflowExecutionInput,
        context: GraphqlRequestContext = {},
      ): Promise<RerunWorkflowExecutionPayload> {
        return rerunWorkflowExecutionMutation(input, context);
      },

      async continueWorkflowExecution(
        input: ContinueWorkflowExecutionInput,
        context: GraphqlRequestContext = {},
      ): Promise<ContinueWorkflowExecutionPayload> {
        return continueWorkflowExecutionMutation(input, context);
      },

      async sendManagerMessage(
        input: SendManagerMessageInput,
        context: GraphqlRequestContext = {},
      ): Promise<SendManagerMessagePayload> {
        const scope = await authenticateManagerScope(
          managerLookupInput(input.managerSessionId),
          context,
          deps,
        );
        assertWorkflowExecutionScope(
          input.workflowId,
          input.workflowExecutionId,
          scope,
        );
        assertManagerIdentity(input, scope);

        const payloadInput: ServiceSendManagerMessageInput = {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          managerSessionId: scope.session.managerSessionId,
          ...(input.message === undefined ? {} : { message: input.message }),
          ...(input.actions === undefined ? {} : { actions: input.actions }),
          ...(input.attachments === undefined
            ? {}
            : { attachments: input.attachments }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        };
        const result = await resolveManagerMessageService(
          context,
          deps,
        ).sendManagerMessage(payloadInput, context);
        return {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          managerSessionId: scope.session.managerSessionId,
          ...result,
        };
      },

      async retryCommunicationDelivery(
        input: RetryCommunicationDeliveryInput,
        context: GraphqlRequestContext = {},
      ): Promise<RetryCommunicationDeliveryPayload> {
        const scope = await authenticateManagerScope(
          managerLookupInput(input.managerSessionId),
          context,
          deps,
        );
        assertWorkflowExecutionScope(
          input.workflowId,
          input.workflowExecutionId,
          scope,
        );
        await loadScopedCommunicationForManagerMutation(input, scope, context);

        const payloadInput: ServiceRetryCommunicationInput = {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          communicationId: input.communicationId,
          managerSessionId: scope.session.managerSessionId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        };
        return resolveCommunicationService(
          context,
          deps,
        ).retryCommunicationDelivery(payloadInput, context);
      },

      async replayCommunication(
        input: ReplayCommunicationInput,
        context: GraphqlRequestContext = {},
      ): Promise<ReplayCommunicationPayload> {
        const scope = await authenticateManagerScope(
          managerLookupInput(input.managerSessionId),
          context,
          deps,
        );
        assertWorkflowExecutionScope(
          input.workflowId,
          input.workflowExecutionId,
          scope,
        );
        await loadScopedCommunicationForManagerMutation(input, scope, context);

        const payloadInput: ServiceReplayCommunicationInput = {
          workflowId: input.workflowId,
          workflowExecutionId: input.workflowExecutionId,
          communicationId: input.communicationId,
          managerSessionId: scope.session.managerSessionId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        };
        return resolveCommunicationService(context, deps).replayCommunication(
          payloadInput,
          context,
        );
      },

      async cancelWorkflowExecution(
        input: CancelWorkflowExecutionInput,
        context: GraphqlRequestContext = {},
      ): Promise<CancelWorkflowExecutionPayload> {
        return cancelWorkflowExecutionMutation(input, context);
      },

      async dispatchSupervisedWorkflowCommand(
        input: DispatchSupervisedWorkflowCommandInput,
        context: GraphqlRequestContext = {},
      ): Promise<SupervisedWorkflowGraphqlPayload> {
        return dispatchSupervisedWorkflowCommandMutation(input, context);
      },

      async dispatchSupervisorChat(
        input: DispatchSupervisorChatGraphqlInput,
        context: GraphqlRequestContext = {},
      ): Promise<DispatchSupervisorChatPayload> {
        return dispatchSupervisorChatMutation(input, context);
      },

      async dispatchSupervisorConversation(
        input: DispatchSupervisorConversationGraphqlInput,
        context: GraphqlRequestContext = {},
      ): Promise<DispatchSupervisorConversationPayload> {
        return dispatchSupervisorConversationMutation(input, context);
      },
    },
  };
}
