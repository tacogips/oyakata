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
import {
  BoxRenderable,
  createCliRenderer,
  KeyEvent,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextareaRenderable,
  TextRenderable,
  type SelectOption,
} from "@opentui/core";

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

export interface OpenTuiWorkflowSelection {
  readonly type: "selected" | "quit";
  readonly workflowName?: string;
}

export interface OpenTuiWorkflowActionResult {
  readonly exitCode: number;
  readonly sessionId: string;
  readonly status: WorkflowSessionState["status"];
}

export interface OpenTuiWorkflowAppOptions {
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
  }) => Promise<OpenTuiWorkflowActionResult>;
  readonly rerunWorkflow: (input: {
    readonly sourceSessionId: string;
    readonly fromNodeId: string;
    readonly runtimeVariables: Readonly<Record<string, unknown>>;
  }) => Promise<OpenTuiWorkflowActionResult>;
  readonly resumeWorkflow: (
    sessionId: string,
  ) => Promise<OpenTuiWorkflowActionResult>;
}

type FocusPane = "input" | "nodes" | "sessions" | "workflows";
type DetailMode = "inbox" | "manager" | "outbox" | "session-logs" | "summary";
type ShortcutKeyEvent = Pick<KeyEvent, "ctrl" | "meta" | "name" | "shift">;

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

function selectBoundedIndex(
  list: SelectRenderable,
  index: number,
  total: number,
): number {
  if (total <= 0) {
    list.setSelectedIndex(0);
    return -1;
  }
  const bounded = Math.max(0, Math.min(index, total - 1));
  list.setSelectedIndex(bounded);
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

const EMPTY_SELECT = "__opentui_empty__";

function workflowNamesToSelectOptions(
  workflowNames: readonly string[],
): SelectOption[] {
  if (workflowNames.length === 0) {
    return [
      { name: "(no workflows found)", description: "", value: EMPTY_SELECT },
    ];
  }
  return workflowNames.map((name) => ({
    name,
    description: "",
    value: name,
  }));
}

function buildSessionSelectOptions(
  sessions: readonly RuntimeSessionSummary[],
): SelectOption[] {
  if (sessions.length === 0) {
    return [
      {
        name: "(no sessions for workflow)",
        description: "",
        value: EMPTY_SELECT,
      },
    ];
  }
  return sessions.map((session) => {
    const tail = session.sessionId.slice(-10);
    return {
      name: `${session.status.padEnd(9)} ${tail} ${session.startedAt}`,
      description: "",
      value: session.sessionId,
    };
  });
}

function buildNodeSelectOptions(
  workflow: LoadedWorkflow | undefined,
  session: WorkflowSessionState | undefined,
): SelectOption[] {
  if (workflow === undefined || session === undefined) {
    return [
      { name: "(no node executions)", description: "", value: EMPTY_SELECT },
    ];
  }
  if (session.nodeExecutions.length === 0) {
    return [
      { name: "(no node executions)", description: "", value: EMPTY_SELECT },
    ];
  }
  return session.nodeExecutions.map((execution) => {
    const kind = resolveNodeKind(workflow.bundle.workflow, execution.nodeId);
    return {
      name: `${execution.status.padEnd(10)} ${execution.nodeId} [${kind}] ${execution.nodeExecId}`,
      description: "",
      value: execution.nodeExecId,
    };
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

const selectJkBindings = [
  { name: "j", action: "move-down" as const },
  { name: "k", action: "move-up" as const },
];

export function isOpenTuiRefreshKey(key: ShortcutKeyEvent): boolean {
  return key.name === "r" && key.shift && !key.ctrl && !key.meta;
}

export async function renderOpenTuiWorkflowSelector(options: {
  workflowNames: readonly string[];
  refreshWorkflowNames: () => Promise<readonly string[]>;
  io: CliIo;
}): Promise<OpenTuiWorkflowSelection> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  });

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const topRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 7,
    width: "100%",
  });

  const workflowPane = new BoxRenderable(renderer, {
    flexGrow: 3,
    height: "100%",
    border: true,
    title: " Workflows ",
    flexDirection: "column",
  });
  const workflowSelect = new SelectRenderable(renderer, {
    id: "sel-workflow",
    showDescription: false,
    flexGrow: 1,
    width: "100%",
    height: "100%",
    keyBindings: selectJkBindings,
  });
  workflowPane.add(workflowSelect);

  const timelineBox = new BoxRenderable(renderer, {
    border: true,
    title: " Timeline ",
    flexGrow: 4,
    height: "100%",
  });
  timelineBox.add(
    new TextRenderable(renderer, {
      flexGrow: 1,
      content: "Execution timeline will appear after run starts.",
    }),
  );

  const detailsBox = new BoxRenderable(renderer, {
    border: true,
    title: " Details ",
    flexGrow: 3,
    height: "100%",
  });
  detailsBox.add(
    new TextRenderable(renderer, {
      flexGrow: 1,
      content: "Select workflow with j/k and press enter.",
    }),
  );

  topRow.add(workflowPane);
  topRow.add(timelineBox);
  topRow.add(detailsBox);

  const bottomRow = new BoxRenderable(renderer, {
    border: true,
    title: " Logs / Keys ",
    flexGrow: 3,
    width: "100%",
  });
  bottomRow.add(
    new TextRenderable(renderer, {
      content: "j/k: move  enter: select  r: refresh  q: quit",
    }),
  );

  root.add(topRow);
  root.add(bottomRow);
  renderer.root.add(root);

  let workflowNames = [...options.workflowNames];
  const updateWorkflows = (names: readonly string[]): void => {
    workflowNames = [...names];
    workflowSelect.options = workflowNamesToSelectOptions(workflowNames);
    workflowSelect.setSelectedIndex(0);
    renderer.requestRender();
  };
  updateWorkflows(workflowNames);

  renderer.start();
  renderer.focusRenderable(workflowSelect);

  return await new Promise<OpenTuiWorkflowSelection>((resolve) => {
    const complete = (result: OpenTuiWorkflowSelection): void => {
      renderer.keyInput.removeListener("keypress", onKey);
      renderer.destroy();
      resolve(result);
    };

    workflowSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_idx, opt) => {
      const v = opt?.value;
      if (v === undefined || v === EMPTY_SELECT) {
        return;
      }
      complete({ type: "selected", workflowName: String(v) });
    });

    const onKey = (key: KeyEvent): void => {
      if (key.eventType !== "press") {
        return;
      }
      if (key.name === "q" && !key.ctrl && !key.meta) {
        key.preventDefault();
        complete({ type: "quit" });
        return;
      }
      if (key.name === "c" && key.ctrl) {
        key.preventDefault();
        complete({ type: "quit" });
        return;
      }
      if (key.name === "r" && !key.ctrl && !key.meta) {
        key.preventDefault();
        void (async () => {
          try {
            updateWorkflows(await options.refreshWorkflowNames());
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : "unknown error";
            options.io.stderr(`tui refresh failed: ${message}`);
          }
        })();
      }
    };

    renderer.keyInput.prependListener("keypress", onKey);
    renderer.requestRender();
  });
}

export async function runOpenTuiWorkflowApp(
  options: OpenTuiWorkflowAppOptions,
): Promise<number> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  });

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const mainRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 58,
    width: "100%",
  });

  const workflowPane = new BoxRenderable(renderer, {
    flexGrow: 20,
    height: "100%",
    border: true,
    title: " Workflows ",
    flexDirection: "column",
  });
  const workflowSelect = new SelectRenderable(renderer, {
    id: "wf-select",
    showDescription: false,
    flexGrow: 1,
    width: "100%",
    height: "100%",
    keyBindings: selectJkBindings,
  });
  workflowPane.add(workflowSelect);

  const sessionPane = new BoxRenderable(renderer, {
    flexGrow: 28,
    height: "100%",
    border: true,
    title: " Sessions ",
    flexDirection: "column",
  });
  const sessionSelect = new SelectRenderable(renderer, {
    id: "sess-select",
    showDescription: false,
    flexGrow: 1,
    width: "100%",
    height: "100%",
    keyBindings: selectJkBindings,
  });
  sessionPane.add(sessionSelect);

  const nodePane = new BoxRenderable(renderer, {
    flexGrow: 22,
    height: "100%",
    border: true,
    title: " Nodes ",
    flexDirection: "column",
  });
  const nodeSelect = new SelectRenderable(renderer, {
    id: "node-select",
    showDescription: false,
    flexGrow: 1,
    width: "100%",
    height: "100%",
    keyBindings: selectJkBindings,
  });
  nodePane.add(nodeSelect);

  const detailScroll = new ScrollBoxRenderable(renderer, {
    id: "detail-scroll",
    flexGrow: 30,
    height: "100%",
    border: true,
    title: " Details ",
    scrollY: true,
  });
  const detailText = new TextRenderable(renderer, {
    id: "detail-text",
    flexGrow: 1,
    width: "100%",
    content: "",
  });
  detailScroll.content.add(detailText);

  mainRow.add(workflowPane);
  mainRow.add(sessionPane);
  mainRow.add(nodePane);
  mainRow.add(detailScroll);

  const inputRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 26,
    width: "100%",
  });

  const inputShell = new BoxRenderable(renderer, {
    id: "input-shell",
    border: true,
    title: " Input ",
    flexGrow: 1,
    height: "100%",
    focusable: true,
  });

  const inputTextarea = new TextareaRenderable(renderer, {
    id: "input-editor",
    flexGrow: 1,
    width: "100%",
    wrapMode: "char",
  });

  inputShell.add(inputTextarea);
  inputRow.add(inputShell);

  const helpBox = new BoxRenderable(renderer, {
    border: true,
    title: " Status / Keys ",
    flexGrow: 16,
    width: "100%",
  });
  const helpText = new TextRenderable(renderer, {
    id: "help-text",
    flexGrow: 1,
    content: "",
  });
  helpBox.add(helpText);

  root.add(mainRow);
  root.add(inputRow);
  root.add(helpBox);
  renderer.root.add(root);

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

  const selectedWorkflowName = (): string | undefined => {
    const opt = workflowSelect.getSelectedOption();
    if (opt === null || opt.value === EMPTY_SELECT) {
      return undefined;
    }
    return String(opt.value);
  };

  const selectedSessionSummary = (): RuntimeSessionSummary | undefined => {
    const opt = sessionSelect.getSelectedOption();
    if (opt === null || opt.value === EMPTY_SELECT) {
      return undefined;
    }
    return workflowSessions.find((s) => s.sessionId === opt.value);
  };

  const selectedNodeExecution = (): NodeExecutionRecord | undefined => {
    if (runtimeSessionView === undefined) {
      return undefined;
    }
    const opt = nodeSelect.getSelectedOption();
    if (opt === null || opt.value === EMPTY_SELECT) {
      return undefined;
    }
    return runtimeSessionView.session.nodeExecutions.find(
      (e) => e.nodeExecId === opt.value,
    );
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
    helpText.content = [
      message,
      "",
      `Focus=${focusPane}  Detail=${detailMode}  InputMode=${workflowInputDetection.mode}  Editing=${String(
        editingInput,
      )}  Busy=${String(busy)}`,
      "tab: focus  enter: load selection  e: edit input  f: format JSON  m: toggle input mode",
      "n: run workflow  r: rerun selected node  u: resume selected session  i/o/g/a: inbox/outbox/logs/manager  R: refresh  q: quit",
    ].join("\n");
  };

  const render = async (): Promise<void> => {
    workflowSelect.options = workflowNamesToSelectOptions(workflowNames);
    selectBoundedIndex(
      workflowSelect,
      workflowNames.findIndex((name) => name === loadedWorkflow?.workflowName),
      workflowNames.length,
    );

    sessionSelect.options = buildSessionSelectOptions(workflowSessions);
    if (workflowSessions.length === 0) {
      sessionSelect.setSelectedIndex(0);
    } else if (runtimeSessionView !== undefined) {
      selectBoundedIndex(
        sessionSelect,
        workflowSessions.findIndex(
          (session) =>
            session.sessionId === runtimeSessionView?.session.sessionId,
        ),
        workflowSessions.length,
      );
    }

    nodeSelect.options = buildNodeSelectOptions(
      loadedWorkflow,
      runtimeSessionView?.session,
    );
    if (
      runtimeSessionView === undefined ||
      runtimeSessionView.session.nodeExecutions.length === 0
    ) {
      nodeSelect.setSelectedIndex(0);
    } else {
      const currentNode = selectedNodeExecution();
      const selectedIndex =
        currentNode === undefined
          ? runtimeSessionView.session.nodeExecutions.length - 1
          : runtimeSessionView.session.nodeExecutions.findIndex(
              (entry) => entry.nodeExecId === currentNode.nodeExecId,
            );
      selectBoundedIndex(
        nodeSelect,
        selectedIndex < 0
          ? runtimeSessionView.session.nodeExecutions.length - 1
          : selectedIndex,
        runtimeSessionView.session.nodeExecutions.length,
      );
    }

    inputShell.title = ` Input (${workflowInputDetection.mode}) `;

    detailText.content = await buildDetailContent({
      detailMode,
      inputDetection: workflowInputDetection,
      loadedWorkflow,
      managerMessages,
      runtimeSessionView,
      selectedNodeExecution: selectedNodeExecution(),
    });
    detailScroll.scrollTop = 0;

    setStatus(lastStatus);
    renderer.requestRender();
  };

  const applyFocus = (nextFocusPane: FocusPane): void => {
    focusPane = nextFocusPane;
    if (focusPane === "workflows") {
      renderer.focusRenderable(workflowSelect);
    } else if (focusPane === "sessions") {
      renderer.focusRenderable(sessionSelect);
    } else if (focusPane === "nodes") {
      renderer.focusRenderable(nodeSelect);
    } else if (editingInput) {
      renderer.focusRenderable(inputTextarea);
    } else {
      renderer.focusRenderable(inputShell);
    }
    setStatus(lastStatus);
    renderer.requestRender();
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
    renderer.requestRender();
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
    selectBoundedIndex(nodeSelect, nextIndex, nodeExecutionCount);
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
      inputTextarea.setText("");
      return;
    }

    loadedWorkflow = await options.loadWorkflowDefinition(workflowName);
    workflowInputDetection = detectWorkflowInputMode(loadedWorkflow);
    workflowSessions = await options.listWorkflowSessions(workflowName);
    const targetSessionId =
      preferredSessionId ?? workflowSessions[0]?.sessionId ?? undefined;
    await refreshSessionView(targetSessionId);
    if (runtimeSessionView !== undefined) {
      inputTextarea.setText(
        deriveEditorTextFromRuntimeVariables(
          runtimeSessionView.session.runtimeVariables,
          workflowInputDetection.mode,
        ),
      );
    } else {
      inputTextarea.setText(
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
  applyFocus(options.initialSessionId === undefined ? "workflows" : "sessions");
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
      editorText: inputTextarea.plainText,
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
            editorText: inputTextarea.plainText,
            mode: workflowInputDetection.mode,
            purpose: "rerun",
          }
        : {
            editorText: inputTextarea.plainText,
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
          inputTextarea.setText(
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
    applyFocus("input");
    setStatus(
      workflowInputDetection.mode === "json"
        ? "Editing JSON input. Press escape to finish."
        : "Editing text input. Press escape to finish.",
    );
    renderer.requestRender();
  };

  const moveFocusedList = async (delta: number): Promise<void> => {
    if (focusPane === "workflows") {
      if (delta < 0) {
        workflowSelect.moveUp(1);
      } else {
        workflowSelect.moveDown(1);
      }
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
      if (delta < 0) {
        sessionSelect.moveUp(1);
      } else {
        sessionSelect.moveDown(1);
      }
      await withBusy("Switching session", async () => {
        await refreshSessionView(selectedSessionSummary()?.sessionId);
        if (runtimeSessionView !== undefined) {
          inputTextarea.setText(
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
      if (delta < 0) {
        nodeSelect.moveUp(1);
      } else {
        nodeSelect.moveDown(1);
      }
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
    applyFocus("input");
  };

  renderer.start();

  return await new Promise<number>((resolve) => {
    const complete = (exitCode: number): void => {
      renderer.keyInput.removeListener("keypress", onKey);
      renderer.destroy();
      resolve(exitCode);
    };

    const onKey = (key: KeyEvent): void => {
      if (key.eventType !== "press") {
        return;
      }

      if (key.name === "escape" && editingInput && focusPane === "input") {
        key.preventDefault();
        editingInput = false;
        applyFocus("input");
        setStatus("Input edit finished");
        void render();
        return;
      }

      if (key.name === "return" && focusPane === "input" && !editingInput) {
        if (renderer.currentFocusedRenderable === inputShell) {
          key.preventDefault();
          void loadFocusedSelection();
          return;
        }
      }

      if (busy) {
        return;
      }

      if (editingInput && renderer.currentFocusedRenderable === inputTextarea) {
        return;
      }

      if (key.name === "q" && !key.ctrl && !key.meta) {
        key.preventDefault();
        complete(0);
        return;
      }
      if (key.name === "c" && key.ctrl) {
        key.preventDefault();
        complete(130);
        return;
      }

      if (key.name === "tab") {
        if (editingInput) {
          return;
        }
        if (key.shift) {
          const previousFocus: Readonly<Record<FocusPane, FocusPane>> = {
            workflows: "input",
            sessions: "workflows",
            nodes: "sessions",
            input: "nodes",
          };
          applyFocus(previousFocus[focusPane]);
        } else {
          const nextFocus: Readonly<Record<FocusPane, FocusPane>> = {
            workflows: "sessions",
            sessions: "nodes",
            nodes: "input",
            input: "workflows",
          };
          applyFocus(nextFocus[focusPane]);
        }
        key.preventDefault();
        return;
      }

      if (key.name === "down" || (key.name === "j" && !key.ctrl)) {
        if (focusPane === "input" && !editingInput) {
          return;
        }
        key.preventDefault();
        void moveFocusedList(1);
        return;
      }
      if (key.name === "up" || (key.name === "k" && !key.ctrl)) {
        if (focusPane === "input" && !editingInput) {
          return;
        }
        key.preventDefault();
        void moveFocusedList(-1);
        return;
      }

      if (key.name === "return") {
        key.preventDefault();
        void loadFocusedSelection();
        return;
      }

      if (key.name === "n" && !key.ctrl) {
        key.preventDefault();
        void runWorkflowAction();
        return;
      }
      if (isOpenTuiRefreshKey(key)) {
        key.preventDefault();
        void refreshAll();
        return;
      }
      if (key.name === "r" && !key.ctrl) {
        key.preventDefault();
        void rerunWorkflowAction();
        return;
      }
      if (key.name === "u" && !key.ctrl) {
        key.preventDefault();
        void resumeWorkflowAction();
        return;
      }
      if (key.name === "e" && !key.ctrl) {
        key.preventDefault();
        void loadFocusedSelection();
        return;
      }
      if (key.name === "m" && !key.ctrl) {
        key.preventDefault();
        const previousMode = workflowInputDetection.mode;
        const nextMode: TuiWorkflowInputMode =
          previousMode === "json" ? "text" : "json";
        try {
          const parsedValue = parseTuiEditorValue(
            inputTextarea.plainText,
            previousMode,
          );
          workflowInputDetection = {
            mode: nextMode,
            reason: "manually toggled inside the TUI",
          };
          inputTextarea.setText(formatEditorValue(parsedValue, nextMode));
          setStatus(`Input mode switched to ${workflowInputDetection.mode}`);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "unknown error";
          setStatus(`Input mode toggle failed: ${message}`);
        }
        void render();
        return;
      }
      if (key.name === "f" && !key.ctrl) {
        key.preventDefault();
        if (workflowInputDetection.mode !== "json") {
          setStatus("JSON formatting is only available when input mode is json");
          void render();
          return;
        }
        try {
          inputTextarea.setText(formatJsonEditorText(inputTextarea.plainText));
          setStatus("Formatted JSON input");
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "unknown error";
          setStatus(`JSON formatting failed: ${message}`);
        }
        void render();
        return;
      }
      if (key.name === "i" && !key.ctrl) {
        key.preventDefault();
        detailMode = "inbox";
        setStatus("Showing node inbox view");
        void render();
        return;
      }
      if (key.name === "o" && !key.ctrl) {
        key.preventDefault();
        detailMode = "outbox";
        setStatus("Showing node outbox view");
        void render();
        return;
      }
      if (key.name === "g" && !key.ctrl) {
        key.preventDefault();
        detailMode = "session-logs";
        setStatus("Showing workflow execution logs");
        void render();
        return;
      }
      if (key.name === "a" && !key.ctrl) {
        key.preventDefault();
        detailMode = "manager";
        void withBusy("Loading manager session", async () => {
          await refreshManagerMessages();
          setStatus("Showing manager-session messages");
        });
        return;
      }
      if (key.name === "s" && !key.ctrl) {
        key.preventDefault();
        detailMode = "summary";
        setStatus("Showing node summary");
        void render();
        return;
      }
    };

    renderer.keyInput.prependListener("keypress", onKey);

    void render();
  });
}
