import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CliIo } from "../cli";
import { resolveNodeExecutionMailboxArtifactPaths } from "../workflow/node-execution-mailbox";
import type { LoadedWorkflow } from "../workflow/load";
import type { ManagerMessageRecord } from "../workflow/manager-session-store";
import type {
  NodeExecutionRecord,
  WorkflowSessionState,
} from "../workflow/session";
import type {
  RuntimeNodeExecutionSummary,
  RuntimeNodeLogEntry,
  RuntimeSessionSummary,
} from "../workflow/runtime-db";
import type { ArgumentBinding, NodePayload } from "../workflow/types";

interface BlessedNode {
  key: (
    keys: string | readonly string[],
    handler: () => void | Promise<void>,
  ) => void;
}

interface BlessedElement extends BlessedNode {
  focus?: () => void;
  hide?: () => void;
  setContent?: (content: string) => void;
  setLabel?: (label: string) => void;
  show?: () => void;
}

interface BlessedScreen extends BlessedElement {
  append: (node: BlessedNode) => void;
  destroy: () => void;
  render: () => void;
}

interface BlessedBox extends BlessedElement {
  getScroll?: () => number;
  scrollTo?: (offset: number) => void;
}

interface BlessedList extends BlessedBox {
  clearItems?: () => void;
  down: (step: number) => void;
  getItemIndex: (item: unknown) => number;
  move?: (offset: number) => void;
  select: (index: number) => void;
  selected?: unknown;
  setItems: (items: readonly string[]) => void;
  up: (step: number) => void;
}

interface BlessedTextarea extends BlessedBox {
  getValue: () => string;
  readInput: (
    callback: (error: unknown, value?: string) => void,
  ) => void | Promise<void>;
  setValue: (value: string) => void;
}

interface BlessedFactory {
  box: (options: Record<string, unknown>) => BlessedBox;
  list: (options: Record<string, unknown>) => BlessedList;
  screen: (options: Record<string, unknown>) => BlessedScreen;
  textarea?: (options: Record<string, unknown>) => BlessedTextarea;
  textbox?: (options: Record<string, unknown>) => BlessedTextarea;
}

interface RuntimeSessionView {
  readonly session: WorkflowSessionState;
  readonly nodeExecutions: readonly RuntimeNodeExecutionSummary[];
  readonly nodeLogs: readonly RuntimeNodeLogEntry[];
}

export type TuiWorkflowInputMode = "json" | "text";

export interface TuiWorkflowInputDetection {
  readonly mode: TuiWorkflowInputMode;
  readonly reason: string;
}

export interface NeoBlessedWorkflowSelection {
  readonly type: "selected" | "quit";
  readonly workflowName?: string;
}

export interface NeoBlessedWorkflowActionResult {
  readonly exitCode: number;
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
}

export interface NeoBlessedWorkflowAppOptions {
  readonly initialWorkflowName?: string;
  readonly initialSessionId?: string;
  readonly io: CliIo;
  readonly workflowNames: readonly string[];
  readonly refreshWorkflowNames: () => Promise<readonly string[]>;
  readonly loadWorkflowDefinition: (workflowName: string) => Promise<LoadedWorkflow>;
  readonly listWorkflowSessions: (
    workflowName: string,
  ) => Promise<readonly RuntimeSessionSummary[]>;
  readonly loadRuntimeSessionView: (
    sessionId: string,
  ) => Promise<RuntimeSessionView>;
  readonly loadManagerSessionMessages: (
    managerSessionId: string,
  ) => Promise<readonly ManagerMessageRecord[]>;
  readonly executeWorkflow: (input: {
    readonly workflowName: string;
    readonly runtimeVariables: Readonly<Record<string, unknown>>;
  }) => Promise<NeoBlessedWorkflowActionResult>;
  readonly rerunWorkflow: (input: {
    readonly sourceSessionId: string;
    readonly fromNodeId: string;
    readonly runtimeVariables: Readonly<Record<string, unknown>>;
  }) => Promise<NeoBlessedWorkflowActionResult>;
  readonly resumeWorkflow: (
    sessionId: string,
  ) => Promise<NeoBlessedWorkflowActionResult>;
}

type FocusPane = "input" | "nodes" | "sessions" | "workflows";
type DetailMode = "inbox" | "manager" | "outbox" | "session-logs" | "summary";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactJson(value: unknown, maxLength = 140): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return "null";
  }
  return truncate(serialized, maxLength);
}

function summarizeLines(value: string | null, maxLength = 600): string {
  if (value === null) {
    return "(not found)";
  }
  return truncate(value.trim().length === 0 ? "(empty)" : value.trim(), maxLength);
}

function getSelectedIndex(list: BlessedList): number {
  return list.getItemIndex(list.selected ?? null);
}

function selectBoundedIndex(
  list: BlessedList,
  index: number,
  total: number,
): number {
  if (total <= 0) {
    list.select(0);
    return -1;
  }
  const bounded = Math.max(0, Math.min(index, total - 1));
  list.select(bounded);
  return bounded;
}

export function resolveSelectedWorkflowName(
  selectedIndex: number,
  workflowNames: readonly string[],
): string | undefined {
  if (selectedIndex < 0 || selectedIndex >= workflowNames.length) {
    return undefined;
  }
  return workflowNames[selectedIndex];
}

function looksLikeStructuredHumanInputBinding(binding: ArgumentBinding): boolean {
  if (binding.source !== "human-input") {
    return false;
  }
  if (binding.sourcePath === undefined || binding.sourcePath.trim().length === 0) {
    return false;
  }
  const normalized = binding.sourcePath.trim().toLowerCase();
  return normalized !== "text" && normalized !== "value";
}

function promptHintsJsonInput(promptTemplate: string | undefined): boolean {
  if (promptTemplate === undefined || promptTemplate.trim().length === 0) {
    return false;
  }
  const normalized = promptTemplate.toLowerCase();
  const positiveSignals = [
    "json",
    "structured",
    "object",
    "fields",
    "keys",
    "schema",
  ];
  const negativeSignals = [
    "plain text",
    "free text",
    "space-separated",
    "natural language",
    "human request",
  ];
  return (
    positiveSignals.some((signal) => normalized.includes(signal)) &&
    !negativeSignals.some((signal) => normalized.includes(signal))
  );
}

function payloadExpectsJsonInput(payload: NodePayload | undefined): boolean {
  if (payload === undefined) {
    return false;
  }
  if (
    (payload.argumentBindings ?? []).some(looksLikeStructuredHumanInputBinding)
  ) {
    return true;
  }
  if (
    payload.argumentsTemplate !== undefined &&
    (payload.argumentBindings ?? []).some(
      (binding) => binding.source === "human-input",
    )
  ) {
    return true;
  }
  return promptHintsJsonInput(payload.promptTemplate);
}

export function detectWorkflowInputMode(
  loaded: Pick<LoadedWorkflow, "bundle" | "workflowName">,
): TuiWorkflowInputDetection {
  const workflow = loaded.bundle.workflow;
  const inputNodeIds = new Set(
    workflow.subWorkflows.map((subWorkflow) => subWorkflow.inputNodeId),
  );
  const inputPayloads = workflow.nodes
    .filter(
      (node) => node.kind === "input" || inputNodeIds.has(node.id),
    )
    .map((node) => loaded.bundle.nodePayloads[node.nodeFile])
    .filter((payload): payload is NodePayload => payload !== undefined);

  if (inputPayloads.some(payloadExpectsJsonInput)) {
    return {
      mode: "json",
      reason:
        "detected structured human-input bindings or JSON-oriented input prompts",
    };
  }

  return {
    mode: "text",
    reason: "defaulted to plain text because the workflow definition has no clear JSON-only hint",
  };
}

function extractTextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    isRecord(value) &&
    typeof value["text"] === "string" &&
    Object.keys(value).length === 1
  ) {
    return value["text"];
  }
  return undefined;
}

export function formatEditorValue(
  value: unknown,
  mode: TuiWorkflowInputMode,
): string {
  if (value === undefined) {
    return mode === "json" ? "{}" : "";
  }
  if (mode === "text") {
    const textValue = extractTextValue(value);
    return textValue ?? compactJson(value, 10_000);
  }
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value) as unknown, null, 2);
    } catch {
      return JSON.stringify({ text: value }, null, 2);
    }
  }
  return JSON.stringify(value, null, 2);
}

export function deriveEditorTextFromRuntimeVariables(
  runtimeVariables: Readonly<Record<string, unknown>>,
  mode: TuiWorkflowInputMode,
): string {
  const preferredValue =
    mode === "json"
      ? runtimeVariables["rerunPrompt"] ??
        runtimeVariables["promptJson"] ??
        runtimeVariables["userPromptJson"] ??
        runtimeVariables["humanInput"] ??
        runtimeVariables["prompt"] ??
        runtimeVariables["userPrompt"]
      : runtimeVariables["rerunPrompt"] ??
        runtimeVariables["humanInput"] ??
        runtimeVariables["prompt"] ??
        runtimeVariables["userPrompt"] ??
        runtimeVariables["promptJson"] ??
        runtimeVariables["userPromptJson"];
  return formatEditorValue(preferredValue, mode);
}

export function parseTuiEditorValue(
  editorText: string,
  mode: TuiWorkflowInputMode,
): unknown {
  if (mode === "text") {
    return editorText;
  }
  const trimmed = editorText.trim();
  if (trimmed.length === 0) {
    return {};
  }
  return JSON.parse(trimmed) as unknown;
}

export function buildTuiRuntimeVariables(input: {
  readonly editorText: string;
  readonly managerSessionId?: string;
  readonly mode: TuiWorkflowInputMode;
  readonly purpose: "rerun" | "run";
}): Readonly<Record<string, unknown>> {
  const parsedValue = parseTuiEditorValue(input.editorText, input.mode);
  if (input.mode === "text") {
    const textValue =
      typeof parsedValue === "string" ? parsedValue : compactJson(parsedValue, 20_000);
    return {
      humanInput: textValue,
      prompt: textValue,
      userPrompt: textValue,
      ...(input.purpose === "rerun" ? { rerunPrompt: textValue } : {}),
      ...(input.managerSessionId === undefined
        ? {}
        : { rerunManagerSessionId: input.managerSessionId }),
    };
  }
  return {
    humanInput: parsedValue,
    promptJson: parsedValue,
    userPromptJson: parsedValue,
    ...(input.purpose === "rerun" ? { rerunPrompt: parsedValue } : {}),
    ...(input.managerSessionId === undefined
      ? {}
      : { rerunManagerSessionId: input.managerSessionId }),
  };
}

export function formatJsonEditorText(editorText: string): string {
  const trimmed = editorText.trim();
  if (trimmed.length === 0) {
    return "{}";
  }
  return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2);
}

function resolveNodeKind(
  workflow: LoadedWorkflow["bundle"]["workflow"],
  nodeId: string,
): string {
  return workflow.nodes.find((entry) => entry.id === nodeId)?.kind ?? "task";
}

function resolveManagerSessionId(
  workflow: LoadedWorkflow["bundle"]["workflow"],
  execution: NodeExecutionRecord,
): string | undefined {
  const kind = resolveNodeKind(workflow, execution.nodeId);
  if (kind !== "root-manager" && kind !== "subworkflow-manager") {
    return undefined;
  }
  return `mgrsess-${execution.nodeExecId}`;
}

function buildWorkflowItems(
  workflowNames: readonly string[],
  selectedWorkflowName: string | undefined,
): readonly string[] {
  return workflowNames.length === 0
    ? ["(no workflows found)"]
    : workflowNames.map((workflowName) =>
        workflowName === selectedWorkflowName ? `> ${workflowName}` : workflowName,
      );
}

function buildSessionItems(
  sessions: readonly RuntimeSessionSummary[],
): readonly string[] {
  return sessions.length === 0
    ? ["(no sessions for workflow)"]
    : sessions.map((session) => {
        const tail = session.sessionId.slice(-10);
        return `${session.status.padEnd(9)} ${tail} ${session.startedAt}`;
      });
}

function buildNodeItems(
  workflow: LoadedWorkflow | undefined,
  session: WorkflowSessionState | undefined,
): readonly string[] {
  if (workflow === undefined || session === undefined) {
    return ["(no node executions)"];
  }
  if (session.nodeExecutions.length === 0) {
    return ["(no node executions)"];
  }
  return session.nodeExecutions.map((execution) => {
    const kind = resolveNodeKind(workflow.bundle.workflow, execution.nodeId);
    return `${execution.status.padEnd(10)} ${execution.nodeId} [${kind}] ${execution.nodeExecId}`;
  });
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function formatLogEntries(
  logEntries: readonly RuntimeNodeLogEntry[],
  limit: number,
): string {
  if (logEntries.length === 0) {
    return "(no logs)";
  }
  return logEntries
    .slice(Math.max(0, logEntries.length - limit))
    .map((entry) => {
      const scope =
        entry.nodeId === null
          ? "workflow"
          : `${entry.nodeId}${entry.nodeExecId === null ? "" : `/${entry.nodeExecId}`}`;
      return `[${entry.at}] [${entry.level}] ${scope}: ${entry.message}`;
    })
    .join("\n");
}

function formatCommunications(
  title: string,
  communications: readonly WorkflowSessionState["communications"][number][],
): string {
  if (communications.length === 0) {
    return `${title}:\n(none)`;
  }
  return [
    `${title}:`,
    ...communications.map(
      (communication) =>
        `- ${communication.communicationId} ${communication.fromNodeId} -> ${communication.toNodeId} ` +
        `[${communication.deliveryKind}] status=${communication.status}`,
    ),
  ].join("\n");
}

async function buildDetailContent(input: {
  readonly detailMode: DetailMode;
  readonly inputDetection: TuiWorkflowInputDetection;
  readonly loadedWorkflow: LoadedWorkflow | undefined;
  readonly managerMessages: readonly ManagerMessageRecord[];
  readonly runtimeSessionView: RuntimeSessionView | undefined;
  readonly selectedNodeExecution: NodeExecutionRecord | undefined;
}): Promise<string> {
  if (input.loadedWorkflow === undefined) {
    return "Select a workflow to browse executions and configure input.";
  }

  if (input.runtimeSessionView === undefined) {
    return [
      `Workflow: ${input.loadedWorkflow.workflowName}`,
      `Input mode: ${input.inputDetection.mode}`,
      `Reason: ${input.inputDetection.reason}`,
      "No historical session is selected yet.",
      "Use `n` to run the workflow with the current editor content.",
    ].join("\n");
  }

  const sessionView = input.runtimeSessionView;
  const session = sessionView.session;
  const selectedExecution =
    input.selectedNodeExecution ?? session.nodeExecutions.at(-1);

  if (selectedExecution === undefined) {
    return [
      `Workflow: ${session.workflowName}`,
      `Session: ${session.sessionId}`,
      "No node executions are available for this session.",
    ].join("\n");
  }

  const runtimeExecution = sessionView.nodeExecutions.find(
    (entry) => entry.nodeExecId === selectedExecution.nodeExecId,
  );
  const nodeLogs = sessionView.nodeLogs.filter(
    (entry) => entry.nodeExecId === selectedExecution.nodeExecId,
  );
  const managerSessionId = resolveManagerSessionId(
    input.loadedWorkflow.bundle.workflow,
    selectedExecution,
  );
  const mailboxPaths = resolveNodeExecutionMailboxArtifactPaths(
    selectedExecution.artifactDir,
  );
  const [artifactInput, artifactOutput, artifactMeta, mailboxMeta, mailboxInput] =
    await Promise.all([
      readOptionalText(path.join(selectedExecution.artifactDir, "input.json")),
      Promise.resolve(
        runtimeExecution?.outputJson ?? null,
      ).then(async (runtimeOutput) =>
        runtimeOutput ?? readOptionalText(path.join(selectedExecution.artifactDir, "output.json")),
      ),
      readOptionalText(path.join(selectedExecution.artifactDir, "meta.json")),
      readOptionalText(mailboxPaths.metaPath),
      readOptionalText(mailboxPaths.inputPath),
    ]);
  const inboundCommunications = session.communications.filter(
    (communication) => communication.consumedByNodeExecId === selectedExecution.nodeExecId,
  );
  const outboundCommunications = session.communications.filter(
    (communication) => communication.sourceNodeExecId === selectedExecution.nodeExecId,
  );

  if (input.detailMode === "session-logs") {
    return [
      `Workflow session logs for ${session.sessionId}`,
      "",
      formatLogEntries(sessionView.nodeLogs, 200),
    ].join("\n");
  }

  if (input.detailMode === "inbox") {
    return [
      `Inbox for ${selectedExecution.nodeId} / ${selectedExecution.nodeExecId}`,
      "",
      "Mailbox meta.json:",
      summarizeLines(mailboxMeta, 8_000),
      "",
      "Mailbox inbox/input.json:",
      summarizeLines(mailboxInput, 8_000),
      "",
      "Execution input.json:",
      summarizeLines(artifactInput, 8_000),
      "",
      formatCommunications("Inbound communications", inboundCommunications),
    ].join("\n");
  }

  if (input.detailMode === "outbox") {
    return [
      `Outbox for ${selectedExecution.nodeId} / ${selectedExecution.nodeExecId}`,
      "",
      "Execution output.json:",
      summarizeLines(artifactOutput, 8_000),
      "",
      "Execution meta.json:",
      summarizeLines(artifactMeta, 8_000),
      "",
      formatCommunications("Outbound communications", outboundCommunications),
    ].join("\n");
  }

  if (input.detailMode === "manager") {
    return [
      `Manager session for ${selectedExecution.nodeId} / ${selectedExecution.nodeExecId}`,
      `managerSessionId: ${managerSessionId ?? "(not a manager node)"}`,
      "",
      input.managerMessages.length === 0
        ? "(no manager-session messages)"
        : input.managerMessages
            .map((message) => {
              const summary =
                message.message === undefined || message.message.length === 0
                  ? "(empty message)"
                  : truncate(message.message, 600);
              return [
                `- ${message.createdAt} ${message.managerMessageId}`,
                `  accepted=${String(message.accepted)} intents=${compactJson(message.parsedIntent, 500)}`,
                `  message=${summary}`,
              ].join("\n");
            })
            .join("\n"),
    ].join("\n");
  }

  const kind = resolveNodeKind(input.loadedWorkflow.bundle.workflow, selectedExecution.nodeId);
  return [
    `Workflow: ${session.workflowName}`,
    `Session: ${session.sessionId} status=${session.status}`,
    `Selected node: ${selectedExecution.nodeId} [${kind}]`,
    `Node execution: ${selectedExecution.nodeExecId} status=${selectedExecution.status}`,
    `Artifact dir: ${selectedExecution.artifactDir}`,
    `Backend session: ${selectedExecution.backendSessionId ?? "(none)"}`,
    `Manager session: ${managerSessionId ?? "(not a manager node)"}`,
    `Current node: ${session.currentNodeId ?? "-"}`,
    `Queue: ${session.queue.join(",") || "-"}`,
    `Input mode: ${input.inputDetection.mode}`,
    `Input hint: ${input.inputDetection.reason}`,
    "",
    "Runtime variables preview:",
    compactJson(session.runtimeVariables, 1_200),
    "",
    "Recent node logs:",
    formatLogEntries(nodeLogs, 12),
  ].join("\n");
}

async function loadBlessedFactory(): Promise<BlessedFactory> {
  const dynamicImport = new Function(
    "moduleName",
    "return import(moduleName);",
  ) as (moduleName: string) => Promise<unknown>;
  const module = (await dynamicImport("neo-blessed")) as BlessedFactory;
  return module;
}

export async function renderNeoBlessedWorkflowSelector(options: {
  workflowNames: readonly string[];
  refreshWorkflowNames: () => Promise<readonly string[]>;
  io: CliIo;
}): Promise<NeoBlessedWorkflowSelection> {
  const blessed = await loadBlessedFactory();
  const screen = blessed.screen({
    smartCSR: true,
    title: "divedra tui",
  });

  const left = blessed.box({
    parent: screen,
    label: " Workflows ",
    border: "line",
    width: "30%",
    height: "70%",
    left: 0,
    top: 0,
  });

  blessed.box({
    parent: screen,
    label: " Timeline ",
    border: "line",
    width: "40%",
    height: "70%",
    left: "30%",
    top: 0,
    content: "Execution timeline will appear after run starts.",
  });

  blessed.box({
    parent: screen,
    label: " Details ",
    border: "line",
    width: "30%",
    height: "70%",
    left: "70%",
    top: 0,
    content: "Select workflow with j/k and press enter.",
  });

  blessed.box({
    parent: screen,
    label: " Logs / Keys ",
    border: "line",
    width: "100%",
    height: "30%",
    left: 0,
    top: "70%",
    content: "j/k: move  enter: select  r: refresh  q: quit",
  });

  const list = blessed.list({
    parent: left,
    keys: true,
    vi: true,
    mouse: true,
    width: "100%-2",
    height: "100%-2",
    top: 1,
    left: 1,
    border: "line",
    items: [],
  });

  const updateWorkflows = (names: readonly string[]): void => {
    list.setItems(names.length > 0 ? names : ["(no workflows found)"]);
    list.select(0);
    screen.render();
  };

  let workflowNames = [...options.workflowNames];
  updateWorkflows(workflowNames);
  list.focus?.();

  const complete = (
    result: NeoBlessedWorkflowSelection,
  ): NeoBlessedWorkflowSelection => {
    screen.destroy();
    return result;
  };

  return await new Promise<NeoBlessedWorkflowSelection>((resolve) => {
    screen.key(["q", "C-c"], () => {
      resolve(complete({ type: "quit" }));
    });

    screen.key(["j"], () => {
      list.down(1);
      screen.render();
    });

    screen.key(["k"], () => {
      list.up(1);
      screen.render();
    });

    screen.key(["r"], async () => {
      try {
        workflowNames = [...(await options.refreshWorkflowNames())];
        updateWorkflows(workflowNames);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "unknown error";
        options.io.stderr(`tui refresh failed: ${message}`);
      }
    });

    screen.key(["enter"], () => {
      const selectedIndex = list.getItemIndex(list.selected ?? null);
      const selectedWorkflowName = resolveSelectedWorkflowName(
        selectedIndex,
        workflowNames,
      );
      if (selectedWorkflowName === undefined) {
        return;
      }
      resolve(
        complete({ type: "selected", workflowName: selectedWorkflowName }),
      );
    });

    screen.render();
  });
}

export async function runNeoBlessedWorkflowApp(
  options: NeoBlessedWorkflowAppOptions,
): Promise<number> {
  const blessed = await loadBlessedFactory();
  const createInput =
    blessed.textarea ??
    blessed.textbox ??
    (() => {
      throw new Error("neo-blessed textarea/textbox widget is unavailable");
    });

  const screen = blessed.screen({
    smartCSR: true,
    title: "divedra tui",
  });

  const workflowPane = blessed.box({
    parent: screen,
    label: " Workflows ",
    border: "line",
    width: "20%",
    height: "58%",
    left: 0,
    top: 0,
  });
  const sessionPane = blessed.box({
    parent: screen,
    label: " Sessions ",
    border: "line",
    width: "28%",
    height: "58%",
    left: "20%",
    top: 0,
  });
  const nodePane = blessed.box({
    parent: screen,
    label: " Nodes ",
    border: "line",
    width: "22%",
    height: "58%",
    left: "48%",
    top: 0,
  });
  const detailPane = blessed.box({
    parent: screen,
    label: " Details ",
    border: "line",
    width: "30%",
    height: "58%",
    left: "70%",
    top: 0,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
  });
  const inputPane = blessed.box({
    parent: screen,
    label: " Input ",
    border: "line",
    width: "100%",
    height: "26%",
    left: 0,
    top: "58%",
  });
  const helpPane = blessed.box({
    parent: screen,
    label: " Status / Keys ",
    border: "line",
    width: "100%",
    height: "16%",
    left: 0,
    top: "84%",
  });

  const workflowList = blessed.list({
    parent: workflowPane,
    keys: true,
    vi: true,
    mouse: true,
    width: "100%-2",
    height: "100%-2",
    top: 1,
    left: 1,
    items: [],
  });
  const sessionList = blessed.list({
    parent: sessionPane,
    keys: true,
    vi: true,
    mouse: true,
    width: "100%-2",
    height: "100%-2",
    top: 1,
    left: 1,
    items: [],
  });
  const nodeList = blessed.list({
    parent: nodePane,
    keys: true,
    vi: true,
    mouse: true,
    width: "100%-2",
    height: "100%-2",
    top: 1,
    left: 1,
    items: [],
  });
  const inputEditor = createInput({
    parent: inputPane,
    keys: true,
    vi: true,
    mouse: true,
    inputOnFocus: false,
    width: "100%-2",
    height: "100%-2",
    top: 1,
    left: 1,
    border: "line",
    scrollbar: {
      ch: " ",
      inverse: true,
    },
  });

  let workflowNames = [...options.workflowNames];
  let loadedWorkflow: LoadedWorkflow | undefined;
  let workflowInputDetection: TuiWorkflowInputDetection = {
    mode: "text",
    reason: "defaulted before loading a workflow",
  };
  let workflowSessions: readonly RuntimeSessionSummary[] = [];
  let runtimeSessionView: RuntimeSessionView | undefined;
  let managerMessages: readonly ManagerMessageRecord[] = [];
  let focusPane: FocusPane = "workflows";
  let detailMode: DetailMode = "summary";
  let busy = false;
  let editingInput = false;
  let lastStatus = "Loading TUI state...";

  const selectedWorkflowName = (): string | undefined =>
    resolveSelectedWorkflowName(getSelectedIndex(workflowList), workflowNames);

  const selectedSessionSummary = (): RuntimeSessionSummary | undefined => {
    const index = getSelectedIndex(sessionList);
    return index < 0 ? undefined : workflowSessions[index];
  };

  const selectedNodeExecution = (): NodeExecutionRecord | undefined => {
    if (runtimeSessionView === undefined) {
      return undefined;
    }
    const index = getSelectedIndex(nodeList);
    if (index < 0) {
      return undefined;
    }
    return runtimeSessionView.session.nodeExecutions[index];
  };

  const selectedManagerSessionId = (): string | undefined => {
    const execution = selectedNodeExecution();
    if (execution === undefined || loadedWorkflow === undefined) {
      return undefined;
    }
    return resolveManagerSessionId(loadedWorkflow.bundle.workflow, execution);
  };

  const setStatus = (message: string): void => {
    lastStatus = message;
    helpPane.setContent?.(
      [
        message,
        "",
        `Focus=${focusPane}  Detail=${detailMode}  InputMode=${workflowInputDetection.mode}  Editing=${String(
          editingInput,
        )}  Busy=${String(busy)}`,
        "tab: focus  enter: load selection  e: edit input  f: format JSON  m: toggle input mode",
        "n: run workflow  r: rerun selected node  u: resume selected session  i/o/g/a: inbox/outbox/logs/manager  R: refresh  q: quit",
      ].join("\n"),
    );
  };

  const render = async (): Promise<void> => {
    workflowList.setItems(
      buildWorkflowItems(workflowNames, loadedWorkflow?.workflowName),
    );
    selectBoundedIndex(
      workflowList,
      workflowNames.findIndex((name) => name === loadedWorkflow?.workflowName),
      workflowNames.length,
    );

    sessionList.setItems(buildSessionItems(workflowSessions));
    if (workflowSessions.length === 0) {
      sessionList.select(0);
    } else if (runtimeSessionView !== undefined) {
      selectBoundedIndex(
        sessionList,
        workflowSessions.findIndex(
          (session) => session.sessionId === runtimeSessionView?.session.sessionId,
        ),
        workflowSessions.length,
      );
    }

    nodeList.setItems(buildNodeItems(loadedWorkflow, runtimeSessionView?.session));
    if (runtimeSessionView === undefined || runtimeSessionView.session.nodeExecutions.length === 0) {
      nodeList.select(0);
    } else {
      const currentNode = selectedNodeExecution();
      const selectedIndex =
        currentNode === undefined
          ? runtimeSessionView.session.nodeExecutions.length - 1
          : runtimeSessionView.session.nodeExecutions.findIndex(
              (entry) => entry.nodeExecId === currentNode.nodeExecId,
            );
      selectBoundedIndex(
        nodeList,
        selectedIndex < 0
          ? runtimeSessionView.session.nodeExecutions.length - 1
          : selectedIndex,
        runtimeSessionView.session.nodeExecutions.length,
      );
    }

    inputPane.setLabel?.(
      ` Input (${workflowInputDetection.mode}) `,
    );
    detailPane.setContent?.(
      await buildDetailContent({
        detailMode,
        inputDetection: workflowInputDetection,
        loadedWorkflow,
        managerMessages,
        runtimeSessionView,
        selectedNodeExecution: selectedNodeExecution(),
      }),
    );
    detailPane.scrollTo?.(0);

    setStatus(lastStatus);
    screen.render();
  };

  const setFocus = (nextFocusPane: FocusPane): void => {
    focusPane = nextFocusPane;
    if (focusPane === "workflows") {
      workflowList.focus?.();
    } else if (focusPane === "sessions") {
      sessionList.focus?.();
    } else if (focusPane === "nodes") {
      nodeList.focus?.();
    } else {
      inputEditor.focus?.();
    }
    setStatus(lastStatus);
    screen.render();
  };

  const withBusy = async (
    label: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    setStatus(`${label}...`);
    screen.render();
    try {
      await action();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      setStatus(`${label} failed: ${message}`);
      options.io.stderr(`tui ${label.toLowerCase()} failed: ${message}`);
    } finally {
      busy = false;
      await render();
    }
  };

  const refreshManagerMessages = async (): Promise<void> => {
    const managerSessionId = selectedManagerSessionId();
    if (managerSessionId === undefined) {
      managerMessages = [];
      return;
    }
    managerMessages = await options.loadManagerSessionMessages(managerSessionId);
  };

  const refreshSessionView = async (
    sessionId: string | undefined,
  ): Promise<void> => {
    if (sessionId === undefined) {
      runtimeSessionView = undefined;
      managerMessages = [];
      return;
    }
    runtimeSessionView = await options.loadRuntimeSessionView(sessionId);
    const nodeExecutionCount = runtimeSessionView.session.nodeExecutions.length;
    const nextIndex = Math.max(0, nodeExecutionCount - 1);
    selectBoundedIndex(nodeList, nextIndex, nodeExecutionCount);
    await refreshManagerMessages();
  };

  const refreshWorkflow = async (
    workflowName: string | undefined,
    preferredSessionId?: string,
  ): Promise<void> => {
    if (workflowName === undefined) {
      loadedWorkflow = undefined;
      workflowSessions = [];
      runtimeSessionView = undefined;
      managerMessages = [];
      workflowInputDetection = {
        mode: "text",
        reason: "defaulted because no workflow is selected",
      };
      inputEditor.setValue("");
      return;
    }

    loadedWorkflow = await options.loadWorkflowDefinition(workflowName);
    workflowInputDetection = detectWorkflowInputMode(loadedWorkflow);
    workflowSessions = await options.listWorkflowSessions(workflowName);
    const targetSessionId =
      preferredSessionId ?? workflowSessions[0]?.sessionId ?? undefined;
    await refreshSessionView(targetSessionId);
    if (runtimeSessionView !== undefined) {
      inputEditor.setValue(
        deriveEditorTextFromRuntimeVariables(
          runtimeSessionView.session.runtimeVariables,
          workflowInputDetection.mode,
        ),
      );
    } else {
      inputEditor.setValue(
        workflowInputDetection.mode === "json" ? "{}" : "",
      );
    }
  };

  await withBusy("Loading workflow state", async () => {
    const initialWorkflowName =
      options.initialWorkflowName !== undefined &&
      workflowNames.includes(options.initialWorkflowName)
        ? options.initialWorkflowName
        : workflowNames[0];
    await refreshWorkflow(initialWorkflowName, options.initialSessionId);
  });
  setFocus(options.initialSessionId === undefined ? "workflows" : "sessions");
  if (options.initialSessionId !== undefined) {
    setStatus(
      `Loaded resume session ${options.initialSessionId}. Press u to resume or inspect the session first.`,
    );
    await render();
  }

  const runWorkflowAction = async (): Promise<void> => {
    const workflowName = selectedWorkflowName();
    if (workflowName === undefined) {
      setStatus("Select a workflow before starting a run");
      await render();
      return;
    }
    const runtimeVariables = buildTuiRuntimeVariables({
      editorText: inputEditor.getValue(),
      mode: workflowInputDetection.mode,
      purpose: "run",
    });
    await withBusy(`Running workflow '${workflowName}'`, async () => {
      const result = await options.executeWorkflow({
        workflowName,
        runtimeVariables,
      });
      await refreshWorkflow(workflowName, result.sessionId);
      setStatus(
        `Run finished: ${result.sessionId} status=${result.status} exitCode=${String(
          result.exitCode,
        )}`,
      );
    });
  };

  const rerunWorkflowAction = async (): Promise<void> => {
    const session = selectedSessionSummary();
    const execution = selectedNodeExecution();
    if (session === undefined || execution === undefined) {
      setStatus("Select a historical session and node execution before rerunning");
      await render();
      return;
    }
    const managerSessionId = selectedManagerSessionId();
    const runtimeVariables = buildTuiRuntimeVariables(
      managerSessionId === undefined
        ? {
            editorText: inputEditor.getValue(),
            mode: workflowInputDetection.mode,
            purpose: "rerun",
          }
        : {
            editorText: inputEditor.getValue(),
            managerSessionId,
            mode: workflowInputDetection.mode,
            purpose: "rerun",
          },
    );
    await withBusy(
      `Rerunning '${execution.nodeId}' from ${session.sessionId}`,
      async () => {
        const result = await options.rerunWorkflow({
          sourceSessionId: session.sessionId,
          fromNodeId: execution.nodeId,
          runtimeVariables,
        });
        await refreshWorkflow(session.workflowName, result.sessionId);
        setStatus(
          `Rerun finished: ${result.sessionId} status=${result.status} exitCode=${String(
            result.exitCode,
          )}`,
        );
      },
    );
  };

  const resumeWorkflowAction = async (): Promise<void> => {
    const session = selectedSessionSummary();
    if (session === undefined) {
      setStatus("Select a session before resuming");
      await render();
      return;
    }
    await withBusy(`Resuming ${session.sessionId}`, async () => {
      const result = await options.resumeWorkflow(session.sessionId);
      await refreshWorkflow(session.workflowName, result.sessionId);
      setStatus(
        `Resume finished: ${result.sessionId} status=${result.status} exitCode=${String(
          result.exitCode,
        )}`,
      );
    });
  };

  const refreshAll = async (): Promise<void> => {
    await withBusy("Refreshing TUI data", async () => {
      workflowNames = [...(await options.refreshWorkflowNames())];
      const preferredWorkflow =
        loadedWorkflow?.workflowName !== undefined &&
        workflowNames.includes(loadedWorkflow.workflowName)
          ? loadedWorkflow.workflowName
          : workflowNames[0];
      await refreshWorkflow(
        preferredWorkflow,
        runtimeSessionView?.session.sessionId,
      );
      setStatus("TUI state refreshed");
    });
  };

  const loadFocusedSelection = async (): Promise<void> => {
    if (focusPane === "workflows") {
      await withBusy("Loading workflow", async () => {
        await refreshWorkflow(selectedWorkflowName());
        setStatus(
          loadedWorkflow === undefined
            ? "No workflow selected"
            : `Loaded workflow '${loadedWorkflow.workflowName}'`,
        );
      });
      return;
    }
    if (focusPane === "sessions") {
      await withBusy("Loading session", async () => {
        await refreshSessionView(selectedSessionSummary()?.sessionId);
        if (runtimeSessionView !== undefined) {
          inputEditor.setValue(
            deriveEditorTextFromRuntimeVariables(
              runtimeSessionView.session.runtimeVariables,
              workflowInputDetection.mode,
            ),
          );
          setStatus(`Loaded session ${runtimeSessionView.session.sessionId}`);
        }
      });
      return;
    }
    if (focusPane === "nodes") {
      await withBusy("Loading node details", async () => {
        await refreshManagerMessages();
        setStatus(
          selectedNodeExecution() === undefined
            ? "No node execution selected"
            : `Loaded node ${selectedNodeExecution()?.nodeId} details`,
        );
      });
      return;
    }
    editingInput = true;
    inputEditor.focus?.();
    setStatus(
      workflowInputDetection.mode === "json"
        ? "Editing JSON input. Press escape/enter according to your terminal widget binding to finish."
        : "Editing text input. Press escape/enter according to your terminal widget binding to finish.",
    );
    screen.render();
    inputEditor.readInput((error, value) => {
      editingInput = false;
      if (error instanceof Error) {
        setStatus(`Input edit failed: ${error.message}`);
      } else {
        inputEditor.setValue(value ?? inputEditor.getValue());
        setStatus("Input updated");
      }
      void render();
    });
  };

  const moveFocusedList = async (delta: number): Promise<void> => {
    if (focusPane === "workflows") {
      (delta < 0 ? workflowList.up(1) : workflowList.down(1));
      await withBusy("Switching workflow", async () => {
        await refreshWorkflow(selectedWorkflowName());
        setStatus(
          selectedWorkflowName() === undefined
            ? "No workflow selected"
            : `Selected workflow '${selectedWorkflowName()}'`,
        );
      });
      return;
    }
    if (focusPane === "sessions") {
      (delta < 0 ? sessionList.up(1) : sessionList.down(1));
      await withBusy("Switching session", async () => {
        await refreshSessionView(selectedSessionSummary()?.sessionId);
        if (runtimeSessionView !== undefined) {
          inputEditor.setValue(
            deriveEditorTextFromRuntimeVariables(
              runtimeSessionView.session.runtimeVariables,
              workflowInputDetection.mode,
            ),
          );
          setStatus(`Selected session '${runtimeSessionView.session.sessionId}'`);
        }
      });
      return;
    }
    if (focusPane === "nodes") {
      (delta < 0 ? nodeList.up(1) : nodeList.down(1));
      await withBusy("Switching node", async () => {
        await refreshManagerMessages();
        const execution = selectedNodeExecution();
        setStatus(
          execution === undefined
            ? "No node execution selected"
            : `Selected node '${execution.nodeId}' (${execution.nodeExecId})`,
        );
      });
      return;
    }
    inputEditor.focus?.();
    screen.render();
  };

  return await new Promise<number>((resolve) => {
    const complete = (exitCode: number): void => {
      screen.destroy();
      resolve(exitCode);
    };

    screen.key(["q"], () => {
      complete(0);
    });
    screen.key(["C-c"], () => {
      complete(130);
    });
    screen.key(["tab"], () => {
      if (editingInput) {
        return;
      }
      const nextFocus: Readonly<Record<FocusPane, FocusPane>> = {
        workflows: "sessions",
        sessions: "nodes",
        nodes: "input",
        input: "workflows",
      };
      setFocus(nextFocus[focusPane]);
    });
    screen.key(["S-tab"], () => {
      if (editingInput) {
        return;
      }
      const previousFocus: Readonly<Record<FocusPane, FocusPane>> = {
        workflows: "input",
        sessions: "workflows",
        nodes: "sessions",
        input: "nodes",
      };
      setFocus(previousFocus[focusPane]);
    });
    screen.key(["j", "down"], () => {
      if (editingInput || busy) {
        return;
      }
      void moveFocusedList(1);
    });
    screen.key(["k", "up"], () => {
      if (editingInput || busy) {
        return;
      }
      void moveFocusedList(-1);
    });
    screen.key(["enter"], () => {
      if (editingInput || busy) {
        return;
      }
      void loadFocusedSelection();
    });
    screen.key(["n"], () => {
      if (editingInput || busy) {
        return;
      }
      void runWorkflowAction();
    });
    screen.key(["r"], () => {
      if (editingInput || busy) {
        return;
      }
      void rerunWorkflowAction();
    });
    screen.key(["u"], () => {
      if (editingInput || busy) {
        return;
      }
      void resumeWorkflowAction();
    });
    screen.key(["R"], () => {
      if (editingInput || busy) {
        return;
      }
      void refreshAll();
    });
    screen.key(["e"], () => {
      if (editingInput || busy) {
        return;
      }
      void loadFocusedSelection();
    });
    screen.key(["m"], () => {
      if (editingInput || busy) {
        return;
      }
      const previousMode = workflowInputDetection.mode;
      const nextMode: TuiWorkflowInputMode =
        previousMode === "json" ? "text" : "json";
      try {
        const parsedValue = parseTuiEditorValue(
          inputEditor.getValue(),
          previousMode,
        );
        workflowInputDetection = {
          mode: nextMode,
          reason: "manually toggled inside the TUI",
        };
        inputEditor.setValue(formatEditorValue(parsedValue, nextMode));
        setStatus(`Input mode switched to ${workflowInputDetection.mode}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "unknown error";
        setStatus(`Input mode toggle failed: ${message}`);
      }
      void render();
    });
    screen.key(["f"], () => {
      if (editingInput || busy) {
        return;
      }
      if (workflowInputDetection.mode !== "json") {
        setStatus("JSON formatting is only available when input mode is json");
        void render();
        return;
      }
      try {
        inputEditor.setValue(formatJsonEditorText(inputEditor.getValue()));
        setStatus("Formatted JSON input");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "unknown error";
        setStatus(`JSON formatting failed: ${message}`);
      }
      void render();
    });
    screen.key(["i"], () => {
      if (editingInput || busy) {
        return;
      }
      detailMode = "inbox";
      setStatus("Showing node inbox view");
      void render();
    });
    screen.key(["o"], () => {
      if (editingInput || busy) {
        return;
      }
      detailMode = "outbox";
      setStatus("Showing node outbox view");
      void render();
    });
    screen.key(["g"], () => {
      if (editingInput || busy) {
        return;
      }
      detailMode = "session-logs";
      setStatus("Showing workflow execution logs");
      void render();
    });
    screen.key(["a"], () => {
      if (editingInput || busy) {
        return;
      }
      detailMode = "manager";
      void withBusy("Loading manager session", async () => {
        await refreshManagerMessages();
        setStatus("Showing manager-session messages");
      });
    });
    screen.key(["s"], () => {
      if (editingInput || busy) {
        return;
      }
      detailMode = "summary";
      setStatus("Showing node summary");
      void render();
    });

    void render();
  });
}
