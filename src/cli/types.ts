import type { ServeStartOptions, StartedServe } from "../server/serve";
import type { EventListenerHandle } from "../events/listener-service";
import type {
  AutoImprovePolicy,
  WorkflowScopeSelector,
  ResolvedWorkflowSource,
} from "../workflow/types";
import type { WorkflowSessionState } from "../workflow/session";
import type {
  listRuntimeNodeExecutions,
  listRuntimeNodeLogs,
  listRuntimeHookEvents,
} from "../workflow/runtime-db";
import type { createCommunicationService } from "../workflow/communication-service";

export type AutoImproveCliInputs = {
  readonly enabled: boolean;
  readonly superviserWorkflowId?: string;
  readonly monitorIntervalMs?: number;
  readonly stallTimeoutMs?: number;
  readonly maxSupervisedAttempts?: number;
  readonly maxWorkflowPatches?: number;
  readonly workflowMutationMode?: "execution-copy" | "in-place";
  readonly allowTargetedRerun?: boolean;
};

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface CliDependencies {
  readonly startServe: (options: ServeStartOptions) => Promise<StartedServe>;
  readonly isInteractiveTerminal: () => boolean;
  readonly waitForServeShutdown?: (started: StartedServe) => Promise<void>;
  readonly waitForEventListenerShutdown?: (
    started: EventListenerHandle,
  ) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readStdin?: () => Promise<string>;
}

export interface CliStorageOptions {
  readonly workflowRoot?: string;
  readonly workflowScope?: WorkflowScopeSelector;
  readonly userRoot?: string;
  readonly projectRoot?: string;
  readonly addonRoot?: string;
  readonly artifactRoot?: string;
  readonly rootDataDir?: string;
  readonly sessionStoreRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface WorkflowSourceOutput {
  readonly scope: ResolvedWorkflowSource["scope"];
  readonly workflowRoot: string;
  readonly workflowDirectory: string;
  readonly scopeRoot?: string;
}

export interface ParsedOptions {
  readonly workflowRoot?: string;
  readonly workflowScope?: WorkflowScopeSelector;
  readonly userRoot?: string;
  readonly projectRoot?: string;
  readonly addonRoot?: string;
  readonly artifactRoot?: string;
  readonly sessionStoreRoot?: string;
  readonly workingDirectory?: string;
  readonly workerOnly: boolean;
  readonly output: "text" | "json" | "table";
  readonly format?: "text" | "json" | "jsonl";
  readonly variablesPath?: string;
  readonly mockScenarioPath?: string;
  readonly dryRun: boolean;
  readonly maxSteps?: number;
  readonly maxLoopIterations?: number;
  readonly defaultTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly host?: string;
  readonly port?: number;
  readonly endpoint?: string;
  readonly authToken?: string;
  readonly authTokenEnv?: string;
  readonly filePath?: string;
  readonly readOnly: boolean;
  readonly noExec: boolean;
  readonly messageJson?: string;
  readonly messageFile?: string;
  readonly promptVariant?: string;
  readonly continueSession: boolean;
  readonly resumeStepExecId?: string;
  readonly vendor?: string;
  readonly eventRoot?: string;
  readonly eventFile?: string;
  readonly sourceId?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly reason?: string;
  readonly autoImprove?: AutoImprovePolicy;
  /** Phase-2: run superviser bundle as nested workflow; requires --auto-improve */
  readonly nestedSuperviser?: boolean;
  readonly continuationStartStepId?: string;
  readonly continuationAfterStepRunId?: string;
  /** When set, restricts `session step-runs` to rows whose resolved step id matches. */
  readonly stepRunsFilterStepId?: string;
}

export interface ParsedArgs {
  readonly positionals: string[];
  readonly options: ParsedOptions;
  readonly error?: string;
}

export interface GraphqlCliTransportOptions {
  readonly endpoint: string;
  readonly authToken?: string;
  readonly managerSessionId?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RemoteWorkflowRunSummary {
  readonly workflowName: string;
  readonly workflowId: string;
  readonly nodeExecutions: number;
  readonly transitions: number;
}

export interface WorkflowExecutionContinuationMetadata {
  readonly continuedFromWorkflowExecutionId?: string;
  readonly continuedAfterStepRunId?: string;
  readonly continuedAfterExecutionOrdinal?: number;
  readonly continuedStartStepId?: string;
  readonly continuationMode?: WorkflowSessionState["continuationMode"];
  readonly historyImports?: WorkflowSessionState["historyImports"];
}

export interface WorkflowExecutionExport {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly workflowName: string;
  readonly status: WorkflowSessionState["status"];
  readonly exportedAt: string;
  /** Explicit lineage for history-linked runs (reproducible continuation metadata). */
  readonly continuationMetadata?: WorkflowExecutionContinuationMetadata;
  readonly session: WorkflowSessionState;
  readonly nodeExecutions: Awaited<
    ReturnType<typeof listRuntimeNodeExecutions>
  >;
  readonly nodeLogs: Awaited<ReturnType<typeof listRuntimeNodeLogs>>;
  readonly hookEvents: Awaited<ReturnType<typeof listRuntimeHookEvents>>;
  readonly communications: readonly NonNullable<
    Awaited<
      ReturnType<
        ReturnType<typeof createCommunicationService>["getCommunication"]
      >
    >
  >[];
}

export type RuntimeNodeLogEntry = Awaited<
  ReturnType<typeof listRuntimeNodeLogs>
>[number];

export interface CliHandlerContext {
  readonly io: CliIo;
  readonly deps: CliDependencies;
  readonly parsed: ParsedArgs;
  readonly positionals: readonly string[];
  readonly command: string | undefined;
  readonly target: string | undefined;
  readonly sharedOptions: CliStorageOptions;
  readonly graphqlCliTransport: GraphqlCliTransportOptions | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}
