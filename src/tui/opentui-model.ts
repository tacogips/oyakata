import type { LoadedWorkflow } from "../workflow/load";
import type {
  NodeExecutionRecord,
  WorkflowSessionState,
} from "../workflow/session";
import type {
  RuntimeNodeExecutionSummary,
  RuntimeNodeLogEntry,
  RuntimeSessionSummary,
} from "../workflow/runtime-db";
import type {
  ArgumentBinding,
  CliAgentBackend,
  NodePayload,
} from "../workflow/types";
import { normalizeCliAgentBackend } from "../workflow/backend";
import { deriveWorkflowVisualization } from "../workflow/visualization";
import {
  StyledText,
  bold,
  brightCyan,
  brightGreen,
  brightMagenta,
  brightWhite,
  brightYellow,
  dim,
  t,
} from "@opentui/core";

export interface RuntimeSessionView {
  readonly session: WorkflowSessionState;
  readonly nodeExecutions: readonly RuntimeNodeExecutionSummary[];
  readonly nodeLogs: readonly RuntimeNodeLogEntry[];
}

export type TuiWorkflowInputMode = "json" | "text";

export interface TuiWorkflowInputDetection {
  readonly mode: TuiWorkflowInputMode;
  readonly reason: string;
}

export interface TuiWorkflowInputSyntax {
  readonly column?: number;
  readonly line?: number;
  readonly status: "not-applicable" | "valid" | "valid-empty" | "invalid";
  readonly summary: string;
}

export type FocusPane = "detail" | "input" | "nodes" | "sessions" | "workflows";

export type DetailMode =
  | "inbox"
  | "manager"
  | "outbox"
  | "session-logs"
  | "summary"
  | "viewer";

export type DetailReturnPane = "nodes" | "sessions";

export type ScreenMode = "history" | "run" | "workspace";

export type HistoryPaneNavigationMode = "list" | "scroll" | "typing";

export type HistoryViewMode = "subworkflow" | "workflow";

export interface OpenTuiCopyTarget {
  readonly label: string;
  readonly value: string;
}

export interface OpenTuiCopyTargetInput {
  readonly focusPane: FocusPane;
  readonly loadedWorkflowId?: string;
  readonly screenMode: ScreenMode;
  readonly selectedNodeExecutionId?: string;
  readonly selectedSessionId?: string;
  readonly selectedSubworkflowId?: string;
  readonly selectedWorkflowName?: string;
  readonly selectedWorkflowNodeId?: string;
}

export interface OpenTuiPaneChrome {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly title: string;
}

export interface OpenTuiPaneChromeState {
  readonly detail: OpenTuiPaneChrome;
  readonly historyHeader: OpenTuiPaneChrome;
  readonly input: OpenTuiPaneChrome;
  readonly node: OpenTuiPaneChrome;
  readonly runStatus: OpenTuiPaneChrome;
  readonly runWorkflow: OpenTuiPaneChrome;
  readonly selectorPreview: OpenTuiPaneChrome;
  readonly session: OpenTuiPaneChrome;
  readonly workflow: OpenTuiPaneChrome;
}

export interface HistoryPaneLabels {
  readonly header: string;
  readonly left: string;
  readonly right: string;
}

export interface DetailJsonViewerSelection {
  readonly body: string;
  readonly kind: "json-viewer";
  readonly title: string;
}

export interface DetailAgentSessionSelection {
  readonly available: boolean;
  readonly backend?: CliAgentBackend;
  readonly kind: "agent-session";
  readonly sessionId?: string;
  readonly title: string;
}

export interface NodeDetailArtifactBundle {
  readonly artifactInput: string | null;
  readonly artifactOutput: string | null;
  readonly artifactMeta: string | null;
  readonly mailboxMeta: string | null;
  readonly mailboxInput: string | null;
  readonly mailboxOutput: string | null;
}

export interface ShortcutKeyLike {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly name: string;
  readonly shift: boolean;
}

export const OPEN_TUI_EMPTY_SELECT_VALUE = "__opentui_empty__";
const SUMMARY_JSON_PREVIEW_LINES = 14;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDetailJsonViewerSelection(
  value: unknown,
): value is DetailJsonViewerSelection {
  return (
    isRecord(value) &&
    value["kind"] === "json-viewer" &&
    typeof value["title"] === "string" &&
    typeof value["body"] === "string"
  );
}

export function isDetailAgentSessionSelection(
  value: unknown,
): value is DetailAgentSessionSelection {
  return (
    isRecord(value) &&
    value["kind"] === "agent-session" &&
    typeof value["title"] === "string" &&
    typeof value["available"] === "boolean" &&
    (value["backend"] === undefined ||
      value["backend"] === "codex-agent" ||
      value["backend"] === "claude-code-agent") &&
    (value["sessionId"] === undefined || typeof value["sessionId"] === "string")
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function hasVisibleText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function compactJson(value: unknown, maxLength = 140): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return "null";
  }
  return truncate(serialized, maxLength);
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

function extractJsonParseLocation(
  message: string,
): Readonly<{ column?: number; line?: number }> {
  const matched = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  if (matched === null) {
    return {};
  }
  const [, lineText, columnText] = matched;
  const line = Number(lineText);
  const column = Number(columnText);
  return {
    ...(Number.isFinite(line) ? { line } : {}),
    ...(Number.isFinite(column) ? { column } : {}),
  };
}

function resolveNodeKind(
  workflow: LoadedWorkflow["bundle"]["workflow"],
  nodeId: string,
): string {
  return workflow.nodes.find((entry) => entry.id === nodeId)?.kind ?? "task";
}

export function findLatestNodeExecution(
  session: WorkflowSessionState,
  nodeId: string,
): NodeExecutionRecord | undefined {
  return [...session.nodeExecutions]
    .reverse()
    .find((entry) => entry.nodeId === nodeId);
}

function summarizePromptHelp(
  promptTemplate: string | undefined,
): string | undefined {
  if (promptTemplate === undefined) {
    return undefined;
  }
  const normalized = promptTemplate
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return normalized === undefined ? undefined : truncate(normalized, 120);
}

export function resolveOwningSubWorkflow(
  workflow: LoadedWorkflow["bundle"]["workflow"],
  nodeId: string,
): LoadedWorkflow["bundle"]["workflow"]["subWorkflows"][number] | undefined {
  return workflow.subWorkflows.find(
    (entry) =>
      entry.managerNodeId === nodeId ||
      entry.inputNodeId === nodeId ||
      entry.outputNodeId === nodeId ||
      entry.nodeIds.includes(nodeId),
  );
}

function resolveNodePurpose(input: {
  readonly nodeId: string;
  readonly payload: NodePayload | undefined;
  readonly workflow: LoadedWorkflow["bundle"]["workflow"];
}): string | undefined {
  const owningSubWorkflow = resolveOwningSubWorkflow(
    input.workflow,
    input.nodeId,
  );
  return (
    input.payload?.description ??
    input.payload?.output?.description ??
    owningSubWorkflow?.description ??
    summarizePromptHelp(input.payload?.promptTemplate)
  );
}

function buildNodeRowDescription(input: {
  readonly execution?: NodeExecutionRecord;
  readonly kind: string;
  readonly purpose?: string;
  readonly workflowLabel?: string;
}): string {
  const parts = [
    `kind: ${input.kind}`,
    ...(input.execution === undefined
      ? []
      : [`exec: ${input.execution.nodeExecId}`]),
    ...(input.workflowLabel === undefined
      ? []
      : [`workflow: ${input.workflowLabel}`]),
    ...(input.purpose === undefined
      ? []
      : [`purpose: ${truncate(input.purpose, 88)}`]),
  ];
  return parts.join("  ");
}

function buildNodeRowName(input: {
  readonly execution?: NodeExecutionRecord;
  readonly nodeId: string;
  readonly workflowLabel?: string;
}): string {
  const workflowSuffix =
    input.workflowLabel === undefined ? "" : ` -> ${input.workflowLabel}`;
  if (input.execution === undefined) {
    return `${input.nodeId}${workflowSuffix}`;
  }
  return `[${input.execution.status.toUpperCase()}] ${input.nodeId}${workflowSuffix}`;
}

function resolveCliAgentBackendForNode(
  payload: NodePayload | undefined,
): CliAgentBackend | undefined {
  if ((payload?.nodeType ?? "agent") !== "agent") {
    return undefined;
  }
  return (
    normalizeCliAgentBackend(payload?.executionBackend ?? payload?.model) ??
    undefined
  );
}

function formatJsonForDisplay(raw: string | null): string {
  if (raw === null || raw.trim().length === 0) {
    return "(no data)";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function takeFirstLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return [
    ...lines.slice(0, maxLines),
    `... (${String(lines.length - maxLines)} more lines)`,
  ].join("\n");
}

function summarizeJsonBlock(raw: string | null): {
  full: string;
  preview: string;
} {
  const full = formatJsonForDisplay(raw);
  const preview = takeFirstLines(full, SUMMARY_JSON_PREVIEW_LINES);
  return { full, preview };
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

function resolveWorkflowFinalResult(
  runtimeSessionView: RuntimeSessionView | undefined,
): unknown {
  const workflowOutput =
    runtimeSessionView?.session.runtimeVariables["workflowOutput"];
  if (workflowOutput !== undefined) {
    return workflowOutput;
  }
  const latestOutput = runtimeSessionView?.nodeExecutions.at(-1)?.outputJson;
  if (latestOutput === undefined || latestOutput.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(latestOutput) as unknown;
  } catch {
    return latestOutput;
  }
}

function looksLikeStructuredHumanInputBinding(
  binding: ArgumentBinding,
): boolean {
  if (binding.source !== "human-input") {
    return false;
  }
  if (
    binding.sourcePath === undefined ||
    binding.sourcePath.trim().length === 0
  ) {
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

function paneTitle(label: string, active: boolean): string {
  return active ? ` >> ${label} << ` : ` ${label} `;
}

function paneBorderColor(active: boolean): string {
  return active ? "#4fd1ff" : "#5b6670";
}

function paneBackgroundColor(active: boolean): string {
  return active ? "#101a22" : "transparent";
}

export function isOpenTuiEmptySelectValue(value: unknown): boolean {
  return value === OPEN_TUI_EMPTY_SELECT_VALUE;
}

export function resolveHistoryPaneNavigationMode(input: {
  readonly detailMode: DetailMode;
  readonly focusPane: FocusPane;
}): HistoryPaneNavigationMode {
  if (input.focusPane === "input") {
    return "typing";
  }
  if (input.focusPane === "detail") {
    return input.detailMode === "summary" ? "list" : "scroll";
  }
  return "list";
}

export function resolveTabFocusTarget(input: {
  readonly direction: "next" | "previous";
  readonly focusPane: FocusPane;
  readonly screenMode: ScreenMode;
}): FocusPane | undefined {
  if (input.screenMode !== "history") {
    return undefined;
  }
  if (input.direction === "next") {
    const nextFocus: Readonly<Record<FocusPane, FocusPane>> = {
      workflows: "sessions",
      sessions: "nodes",
      nodes: "detail",
      detail: "input",
      input: "sessions",
    };
    return nextFocus[input.focusPane];
  }
  const previousFocus: Readonly<Record<FocusPane, FocusPane>> = {
    workflows: "input",
    sessions: "input",
    nodes: "sessions",
    detail: "nodes",
    input: "detail",
  };
  return previousFocus[input.focusPane];
}

export function resolveOpenTuiInternallyHandledListId(input: {
  readonly detailMode: DetailMode;
  readonly detailSummarySelectId: string;
  readonly focusPane: FocusPane;
  readonly nodeSelectId: string;
  readonly screenMode: ScreenMode;
  readonly sessionSelectId: string;
  readonly workflowSelectId: string;
}): string | undefined {
  if (input.screenMode === "workspace") {
    return input.workflowSelectId;
  }
  if (input.screenMode !== "history") {
    return undefined;
  }
  if (input.focusPane === "sessions") {
    return input.sessionSelectId;
  }
  if (input.focusPane === "nodes") {
    return input.nodeSelectId;
  }
  if (input.focusPane === "detail" && input.detailMode === "summary") {
    return input.detailSummarySelectId;
  }
  return undefined;
}

export function resolveOpenTuiCopyTarget(
  input: OpenTuiCopyTargetInput,
): OpenTuiCopyTarget | undefined {
  if (input.screenMode === "workspace") {
    if (input.loadedWorkflowId !== undefined) {
      return {
        label: "workflow id",
        value: input.loadedWorkflowId,
      };
    }
    if (input.selectedWorkflowName !== undefined) {
      return {
        label: "workflow name",
        value: input.selectedWorkflowName,
      };
    }
    return undefined;
  }

  if (input.screenMode === "run") {
    return undefined;
  }

  if (input.focusPane === "sessions" && input.selectedSessionId !== undefined) {
    return {
      label: "workflow run id",
      value: input.selectedSessionId,
    };
  }

  if (
    input.focusPane === "nodes" &&
    input.selectedNodeExecutionId !== undefined
  ) {
    return {
      label: "node execution id",
      value: input.selectedNodeExecutionId,
    };
  }

  if (
    input.focusPane === "sessions" &&
    input.selectedWorkflowNodeId !== undefined
  ) {
    return {
      label: "workflow node id",
      value: input.selectedWorkflowNodeId,
    };
  }

  if (
    input.focusPane === "nodes" &&
    input.selectedSubworkflowId !== undefined
  ) {
    return {
      label: "workflow id",
      value: input.selectedSubworkflowId,
    };
  }

  return undefined;
}

export function isAllowedNodeDetailKey(input: ShortcutKeyLike): boolean {
  return (
    input.name === "up" ||
    input.name === "down" ||
    input.name === "tab" ||
    (input.name === "j" && !input.ctrl && !input.meta) ||
    (input.name === "k" && !input.ctrl && !input.meta) ||
    input.name === "left" ||
    input.name === "right" ||
    input.name === "escape" ||
    input.name === "return" ||
    (input.name === "m" && input.ctrl && !input.meta)
  );
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

export function normalizeWorkflowFilterText(value: string): string {
  return value.replace(/\r?\n/g, "").trim();
}

export function filterWorkflowNames(
  workflowNames: readonly string[],
  filterText: string,
): readonly string[] {
  const normalizedFilter =
    normalizeWorkflowFilterText(filterText).toLowerCase();
  if (normalizedFilter.length === 0) {
    return [...workflowNames];
  }
  return workflowNames.filter((name) =>
    name.toLowerCase().includes(normalizedFilter),
  );
}

export function detectWorkflowInputMode(
  loaded: Pick<LoadedWorkflow, "bundle" | "workflowName">,
): TuiWorkflowInputDetection {
  const workflow = loaded.bundle.workflow;
  const inputNodeIds = new Set(
    workflow.subWorkflows.map((subWorkflow) => subWorkflow.inputNodeId),
  );
  const inputPayloads = workflow.nodes
    .filter((node) => node.kind === "input" || inputNodeIds.has(node.id))
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
    reason:
      "defaulted to plain text because the workflow definition has no clear JSON-only hint",
  };
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
      ? (runtimeVariables["rerunPrompt"] ??
        runtimeVariables["promptJson"] ??
        runtimeVariables["userPromptJson"] ??
        runtimeVariables["humanInput"] ??
        runtimeVariables["prompt"] ??
        runtimeVariables["userPrompt"])
      : (runtimeVariables["rerunPrompt"] ??
        runtimeVariables["humanInput"] ??
        runtimeVariables["prompt"] ??
        runtimeVariables["userPrompt"] ??
        runtimeVariables["promptJson"] ??
        runtimeVariables["userPromptJson"]);
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
      typeof parsedValue === "string"
        ? parsedValue
        : compactJson(parsedValue, 20_000);
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

export function describeTuiWorkflowInputSyntax(
  editorText: string,
  mode: TuiWorkflowInputMode,
): TuiWorkflowInputSyntax {
  if (mode === "text") {
    return {
      status: "not-applicable",
      summary: "plain text",
    };
  }

  const trimmed = editorText.trim();
  if (trimmed.length === 0) {
    return {
      status: "valid-empty",
      summary: "empty buffer -> {}",
    };
  }

  try {
    JSON.parse(trimmed) as unknown;
    return {
      status: "valid",
      summary: "valid JSON",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    const location = extractJsonParseLocation(message);
    return {
      status: "invalid",
      summary:
        location.line === undefined || location.column === undefined
          ? `invalid JSON: ${message}`
          : `invalid JSON at line ${String(location.line)}, column ${String(location.column)}`,
      ...location,
    };
  }
}

export function resolveHistoryPaneLabels(input: {
  readonly hasRuntimeSession: boolean;
  readonly subworkflow:
    | LoadedWorkflow["bundle"]["workflow"]["subWorkflows"][number]
    | undefined;
}): HistoryPaneLabels {
  if (input.subworkflow === undefined) {
    return {
      header: "Workflow",
      left: "Workflow Runs",
      right: input.hasRuntimeSession ? "Nodes" : "Nodes (select a run)",
    };
  }
  return {
    header: `Subworkflow ${input.subworkflow.id}`,
    left: "Workflow Nodes",
    right: "Workflow List",
  };
}

export function buildDetailEscapeStatusMessage(input: {
  readonly detailReturnPane: DetailReturnPane;
  readonly historyViewMode: HistoryViewMode;
}): string {
  if (input.detailReturnPane === "nodes") {
    return "Focused nodes";
  }
  return input.historyViewMode === "workflow"
    ? "Focused workflow runs"
    : "Focused workflow nodes";
}

export function resolveDirectChildSubworkflows(input: {
  readonly parentSubworkflowId: string;
  readonly workflow: LoadedWorkflow["bundle"]["workflow"];
}): readonly LoadedWorkflow["bundle"]["workflow"]["subWorkflows"][number][] {
  const parent = input.workflow.subWorkflows.find(
    (entry) => entry.id === input.parentSubworkflowId,
  );
  if (parent === undefined) {
    return [];
  }
  const descendants = input.workflow.subWorkflows.filter((candidate) => {
    if (candidate.id === parent.id) {
      return false;
    }
    return candidate.nodeIds.every((nodeId) => parent.nodeIds.includes(nodeId));
  });
  return descendants.filter(
    (candidate) =>
      !descendants.some((other) => {
        if (other.id === candidate.id) {
          return false;
        }
        return candidate.nodeIds.every((nodeId) =>
          other.nodeIds.includes(nodeId),
        );
      }),
  );
}

export function buildOpenTuiBreadcrumb(input: {
  readonly loadedWorkflow: LoadedWorkflow | undefined;
  readonly screenMode: ScreenMode;
  readonly selectedWorkflowName?: string;
  readonly subworkflowPath: readonly string[];
}): string {
  const workflowLabel =
    input.loadedWorkflow?.bundle.workflow.workflowId ??
    input.selectedWorkflowName;
  const segments =
    input.screenMode === "workspace" && workflowLabel === undefined
      ? ["workspace"]
      : [
          "workspace",
          ...(workflowLabel === undefined ? [] : [workflowLabel]),
          ...(input.screenMode === "workspace"
            ? []
            : input.screenMode === "run"
              ? ["new-run"]
              : ["history", ...input.subworkflowPath]),
        ];
  return segments.join(" > ");
}

export function workflowNamesToSelectOptions(
  workflowNames: readonly string[],
): ReadonlyArray<{
  readonly description: string;
  readonly name: string;
  readonly value: string;
}> {
  return workflowNames.map((name) => ({
    description: "press enter for history or ctrl-m for a new run",
    name,
    value: name,
  }));
}

export function resolveAgentSessionSummarySelection(input: {
  readonly execution: NodeExecutionRecord;
  readonly payload: NodePayload | undefined;
}): DetailAgentSessionSelection | undefined {
  const backend = resolveCliAgentBackendForNode(input.payload);
  if (backend === undefined) {
    return undefined;
  }
  return {
    available:
      input.execution.backendSessionId !== undefined &&
      input.execution.backendSessionId.length > 0,
    ...(input.execution.backendSessionId === undefined
      ? {}
      : { sessionId: input.execution.backendSessionId }),
    backend,
    kind: "agent-session",
    title: `AI agent session (${backend})`,
  };
}

export function resolveWorkflowPreviewIndent(input: {
  readonly derivedIndent: number;
  readonly inSubworkflowScope: boolean;
  readonly kind: string;
}): number {
  if (input.kind === "root-manager") {
    return 0;
  }
  if (input.inSubworkflowScope) {
    return input.derivedIndent + 1;
  }
  return input.derivedIndent;
}

function buildWorkflowNodePreview(loaded: LoadedWorkflow): StyledText {
  const derivedNodes = deriveWorkflowVisualization({
    workflow: loaded.bundle.workflow,
    workflowVis: loaded.bundle.workflowVis,
  });
  const nodeRefById = new Map(
    loaded.bundle.workflow.nodes.map((node) => [node.id, node] as const),
  );
  const subWorkflowByNodeId = new Map<string, string>();
  const subWorkflowScopeNodeIds = new Set<string>();
  loaded.bundle.workflow.subWorkflows.forEach((subWorkflow) => {
    subWorkflowScopeNodeIds.add(subWorkflow.managerNodeId);
    subWorkflowScopeNodeIds.add(subWorkflow.inputNodeId);
    subWorkflowScopeNodeIds.add(subWorkflow.outputNodeId);
    subWorkflow.nodeIds.forEach((nodeId) => {
      subWorkflowByNodeId.set(nodeId, subWorkflow.description);
      subWorkflowScopeNodeIds.add(nodeId);
    });
  });
  const chunks: StyledText["chunks"] = [];

  const append = (value: StyledText): void => {
    chunks.push(...value.chunks);
  };

  const nodeTitle = (nodeId: string, kind: string) => {
    if (kind === "root-manager") {
      return brightMagenta(bold(nodeId));
    }
    if (kind === "subworkflow-manager") {
      return brightCyan(bold(nodeId));
    }
    if (kind === "input") {
      return brightGreen(bold(nodeId));
    }
    if (kind === "output") {
      return brightYellow(bold(nodeId));
    }
    return brightWhite(bold(nodeId));
  };

  derivedNodes.forEach((entry, index) => {
    const nodeRef = nodeRefById.get(entry.id);
    const payload =
      nodeRef === undefined
        ? undefined
        : loaded.bundle.nodePayloads[nodeRef.nodeFile];
    const kind = nodeRef?.kind ?? "task";
    const previewIndent = resolveWorkflowPreviewIndent({
      derivedIndent: entry.indent,
      inSubworkflowScope: subWorkflowScopeNodeIds.has(entry.id),
      kind,
    });
    const indent = "  ".repeat(previewIndent);
    const details = [
      `type: ${kind}/${payload?.nodeType ?? "agent"}`,
      ...(payload?.executionBackend === undefined
        ? []
        : [`backend: ${payload.executionBackend}`]),
      ...(payload?.model === undefined ? [] : [`model: ${payload.model}`]),
    ].join("  ");
    const purpose =
      payload?.description ??
      payload?.output?.description ??
      subWorkflowByNodeId.get(entry.id) ??
      summarizePromptHelp(payload?.promptTemplate);

    append(t`${dim(`${indent}----------------------------------------\n`)}`);
    append(t`${indent}${nodeTitle(entry.id, kind)}\n`);
    append(t`${dim(`${indent}${details}\n`)}`);
    if (purpose !== undefined) {
      append(t`${indent}${brightWhite("purpose:")} ${purpose}\n`);
    }
    if (kind === "root-manager") {
      append(
        t`${indent}${brightWhite("workflow id:")} ${loaded.bundle.workflow.workflowId}\n`,
      );
    }
    if (index === derivedNodes.length - 1) {
      append(t`${dim(`${indent}----------------------------------------`)}`);
    }
  });

  return new StyledText(chunks);
}

export function buildWorkflowSummaryPreview(
  loadedWorkflow: LoadedWorkflow | undefined,
): StyledText {
  if (loadedWorkflow === undefined) {
    return t`${dim("Loading workflow detail...")}`;
  }

  const chunks: StyledText["chunks"] = [];
  const append = (value: StyledText): void => {
    chunks.push(...value.chunks);
  };

  append(
    t`${dim(
      `Nodes: ${String(
        loadedWorkflow.bundle.workflow.nodes.length,
      )}  Sub-workflows: ${String(
        loadedWorkflow.bundle.workflow.subWorkflows.length,
      )}`,
    )}\n\n`,
  );
  append(t`${brightWhite(bold("Node Structure"))}\n`);
  append(buildWorkflowNodePreview(loadedWorkflow));
  return new StyledText(chunks);
}

export function buildWorkflowSelectorPreview(input: {
  readonly filteredWorkflowNamesCount: number;
  readonly loadedWorkflow: LoadedWorkflow | undefined;
  readonly selectorPreviewWorkflow: LoadedWorkflow | undefined;
  readonly selectedWorkflowName?: string;
  readonly workflowFilterText: string;
  readonly workflowNamesCount: number;
}): StyledText {
  if (input.selectedWorkflowName === undefined) {
    return t`${
      input.workflowFilterText.length === 0
        ? "No workflow is selected."
        : `No workflows match filter '${input.workflowFilterText}'.`
    }`;
  }
  const previewWorkflow =
    input.selectorPreviewWorkflow?.workflowName === input.selectedWorkflowName
      ? input.selectorPreviewWorkflow
      : input.loadedWorkflow?.workflowName === input.selectedWorkflowName
        ? input.loadedWorkflow
        : undefined;
  const chunks: StyledText["chunks"] = [];
  chunks.push(
    ...t`${brightWhite("Workflow:")} ${bold(input.selectedWorkflowName)}\n${dim(
      `Filter: ${input.workflowFilterText.length === 0 ? "(none)" : input.workflowFilterText}  Matches: ${String(
        input.filteredWorkflowNamesCount,
      )}/${String(input.workflowNamesCount)}`,
    )}\n\n`.chunks,
  );
  chunks.push(...buildWorkflowSummaryPreview(previewWorkflow).chunks);
  return new StyledText(chunks);
}

export function buildWorkflowHistoryHeader(
  loadedWorkflow: LoadedWorkflow | undefined,
  subworkflow:
    | LoadedWorkflow["bundle"]["workflow"]["subWorkflows"][number]
    | undefined,
): StyledText {
  if (loadedWorkflow === undefined) {
    return t`${dim("No workflow loaded.")}`;
  }
  const workflowDescription = hasVisibleText(
    loadedWorkflow.bundle.workflow.description,
  )
    ? loadedWorkflow.bundle.workflow.description
    : undefined;
  const scopeLines =
    subworkflow === undefined
      ? []
      : [
          `scope=${subworkflow.id}`,
          ...(hasVisibleText(subworkflow.description)
            ? [subworkflow.description]
            : []),
          `nodes=${String(subworkflow.nodeIds.length)}  manager=${subworkflow.managerNodeId}`,
        ];
  const chunks: StyledText["chunks"] = [];
  chunks.push(
    ...t`${brightCyan(bold(loadedWorkflow.bundle.workflow.workflowId))}`.chunks,
  );
  if (workflowDescription !== undefined) {
    chunks.push(...t`\n${brightWhite(workflowDescription)}`.chunks);
  }
  chunks.push(
    ...t`\n${dim(
      `nodes=${String(loadedWorkflow.bundle.workflow.nodes.length)}  subworkflows=${String(
        loadedWorkflow.bundle.workflow.subWorkflows.length,
      )}`,
    )}`.chunks,
  );
  if (scopeLines.length > 0) {
    chunks.push(...t`\n${scopeLines.join("\n")}`.chunks);
  }
  return new StyledText(chunks);
}

export function buildSessionSelectOptions(
  sessions: readonly RuntimeSessionSummary[],
): ReadonlyArray<{
  readonly description: string;
  readonly name: string;
  readonly value: string;
}> {
  if (sessions.length === 0) {
    return [
      {
        name: "(no workflow runs)",
        description: "",
        value: OPEN_TUI_EMPTY_SELECT_VALUE,
      },
    ];
  }
  return sessions.map((session) => ({
    name: `[${session.status.toUpperCase()}] ${session.startedAt}`,
    description: `run id: ${session.sessionId}`,
    value: session.sessionId,
  }));
}

export function buildNodeSelectOptions(
  workflow: LoadedWorkflow | undefined,
  session: WorkflowSessionState | undefined,
): ReadonlyArray<{
  readonly description: string;
  readonly name: string;
  readonly value: string;
}> {
  if (workflow === undefined || session === undefined) {
    return [];
  }
  if (session.nodeExecutions.length === 0) {
    return [];
  }
  return session.nodeExecutions.map((execution) => {
    const kind = resolveNodeKind(workflow.bundle.workflow, execution.nodeId);
    const payload =
      workflow.bundle.nodePayloads[
        workflow.bundle.workflow.nodes.find(
          (entry) => entry.id === execution.nodeId,
        )?.nodeFile ?? ""
      ];
    const owningSubworkflow = resolveOwningSubWorkflow(
      workflow.bundle.workflow,
      execution.nodeId,
    );
    const purpose = resolveNodePurpose({
      nodeId: execution.nodeId,
      payload,
      workflow: workflow.bundle.workflow,
    });
    return {
      name: buildNodeRowName({
        execution,
        nodeId: execution.nodeId,
        ...(owningSubworkflow === undefined
          ? {}
          : { workflowLabel: owningSubworkflow.id }),
      }),
      description: buildNodeRowDescription(
        purpose === undefined
          ? {
              execution,
              kind,
              ...(owningSubworkflow === undefined
                ? {}
                : { workflowLabel: owningSubworkflow.id }),
            }
          : {
              execution,
              kind,
              purpose,
              ...(owningSubworkflow === undefined
                ? {}
                : { workflowLabel: owningSubworkflow.id }),
            },
      ),
      value: execution.nodeExecId,
    };
  });
}

export function buildSubworkflowNodeSelectOptions(
  workflow: LoadedWorkflow | undefined,
  session: WorkflowSessionState | undefined,
  subworkflowId: string | undefined,
): ReadonlyArray<{
  readonly description: string;
  readonly name: string;
  readonly value: string;
}> {
  if (
    workflow === undefined ||
    session === undefined ||
    subworkflowId === undefined
  ) {
    return [];
  }
  const subworkflow = workflow.bundle.workflow.subWorkflows.find(
    (entry) => entry.id === subworkflowId,
  );
  if (subworkflow === undefined) {
    return [];
  }
  return subworkflow.nodeIds.map((nodeId) => {
    const kind = resolveNodeKind(workflow.bundle.workflow, nodeId);
    const execution = findLatestNodeExecution(session, nodeId);
    const payload =
      workflow.bundle.nodePayloads[
        workflow.bundle.workflow.nodes.find((entry) => entry.id === nodeId)
          ?.nodeFile ?? ""
      ];
    return {
      name: buildNodeRowName({
        ...(execution === undefined ? {} : { execution }),
        nodeId,
      }),
      description: (() => {
        const purpose = resolveNodePurpose({
          nodeId,
          payload,
          workflow: workflow.bundle.workflow,
        });
        return buildNodeRowDescription(
          purpose === undefined
            ? {
                ...(execution === undefined ? {} : { execution }),
                kind,
              }
            : {
                ...(execution === undefined ? {} : { execution }),
                kind,
                purpose,
              },
        );
      })(),
      value: nodeId,
    };
  });
}

export function buildSubworkflowListOptions(
  workflow: LoadedWorkflow | undefined,
  subworkflowId: string | undefined,
): ReadonlyArray<{
  readonly description: string;
  readonly name: string;
  readonly value: string;
}> {
  if (workflow === undefined || subworkflowId === undefined) {
    return [];
  }
  return resolveDirectChildSubworkflows({
    parentSubworkflowId: subworkflowId,
    workflow: workflow.bundle.workflow,
  }).map((entry) => ({
    name: entry.id,
    description: `${truncate(entry.description, 92)}  manager: ${entry.managerNodeId}`,
    value: entry.id,
  }));
}

export function buildSummaryJsonSelectOptions(input: {
  readonly agentSessionSelection?: DetailAgentSessionSelection;
  readonly bundle: NodeDetailArtifactBundle;
}): ReadonlyArray<{
  readonly description: string;
  readonly name: string;
  readonly value: DetailAgentSessionSelection | DetailJsonViewerSelection;
}> {
  const execIn = summarizeJsonBlock(input.bundle.artifactInput);
  const inbox = summarizeJsonBlock(input.bundle.mailboxInput);
  const execOut = summarizeJsonBlock(input.bundle.artifactOutput);
  const mOut = summarizeJsonBlock(input.bundle.mailboxOutput);
  return [
    ...(input.agentSessionSelection === undefined
      ? []
      : [
          {
            name: input.agentSessionSelection.title,
            description:
              input.agentSessionSelection.available !== true
                ? "backend session id is unavailable for this node execution"
                : `sessionId: ${input.agentSessionSelection.sessionId ?? "(missing)"}`,
            value: input.agentSessionSelection,
          },
        ]),
    {
      name: "Execution input (input.json)",
      description: execIn.preview,
      value: {
        kind: "json-viewer",
        title: "Execution input (input.json)",
        body: execIn.full,
      },
    },
    {
      name: "Inbox message (mailbox inbox/input.json)",
      description: inbox.preview,
      value: {
        kind: "json-viewer",
        title: "Inbox message (mailbox inbox/input.json)",
        body: inbox.full,
      },
    },
    {
      name: "Execution output (output.json)",
      description: execOut.preview,
      value: {
        kind: "json-viewer",
        title: "Execution output (output.json)",
        body: execOut.full,
      },
    },
    {
      name: "Outbox message (mailbox outbox/output.json)",
      description: mOut.preview,
      value: {
        kind: "json-viewer",
        title: "Outbox message (mailbox outbox/output.json)",
        body: mOut.full,
      },
    },
  ];
}

export function buildSummaryDetailHeaderText(input: {
  readonly loadedWorkflow: LoadedWorkflow;
  readonly inputDetection: TuiWorkflowInputDetection;
  readonly nodeLogs: readonly RuntimeNodeLogEntry[];
  readonly selectedExecution: NodeExecutionRecord;
  readonly session: WorkflowSessionState;
}): string {
  const kind = resolveNodeKind(
    input.loadedWorkflow.bundle.workflow,
    input.selectedExecution.nodeId,
  );
  const managerSessionId = resolveManagerSessionId(
    input.loadedWorkflow.bundle.workflow,
    input.selectedExecution,
  );
  const nodeLogs = input.nodeLogs.filter(
    (entry) => entry.nodeExecId === input.selectedExecution.nodeExecId,
  );
  return [
    `Workflow run: ${input.session.sessionId} status=${input.session.status}`,
    `Node: ${input.selectedExecution.nodeId} [${kind}] status=${input.selectedExecution.status}`,
    `Node execution: ${input.selectedExecution.nodeExecId}`,
    `Artifact dir: ${input.selectedExecution.artifactDir}`,
    `Backend session: ${input.selectedExecution.backendSessionId ?? "(none)"}`,
    `Manager session: ${managerSessionId ?? "(not a manager node)"}`,
    `Current node: ${input.session.currentNodeId ?? "-"}`,
    `Queue: ${input.session.queue.join(",") || "-"}`,
    `Input mode: ${input.inputDetection.mode}`,
    `Input hint: ${input.inputDetection.reason}`,
    "",
    "Recent node logs:",
    formatLogEntries(nodeLogs, 12),
  ].join("\n");
}

export function resolveManagerSessionId(
  workflow: LoadedWorkflow["bundle"]["workflow"],
  execution: NodeExecutionRecord,
): string | undefined {
  const kind = resolveNodeKind(workflow, execution.nodeId);
  if (kind !== "root-manager" && kind !== "subworkflow-manager") {
    return undefined;
  }
  return `mgrsess-${execution.nodeExecId}`;
}

export function resolveOpenTuiPaneChrome(input: {
  readonly focusPane: FocusPane;
  readonly hasRuntimeSession: boolean;
  readonly historyPaneLabels: HistoryPaneLabels;
  readonly inputMode: TuiWorkflowInputMode;
  readonly inputSyntaxStatus: TuiWorkflowInputSyntax["status"];
  readonly screenMode: ScreenMode;
}): OpenTuiPaneChromeState {
  const workspaceWorkflowsActive =
    input.screenMode === "workspace" && input.focusPane === "workflows";
  const inputSyntaxSuffix =
    input.inputMode === "json"
      ? `, ${input.inputSyntaxStatus === "invalid" ? "syntax error" : "syntax ok"}`
      : "";
  return {
    detail: {
      backgroundColor: "transparent",
      borderColor: paneBorderColor(
        input.screenMode === "history" && input.focusPane === "detail",
      ),
      title: paneTitle(
        "node detail",
        input.screenMode === "history" && input.focusPane === "detail",
      ),
    },
    historyHeader: {
      backgroundColor: "transparent",
      borderColor: paneBorderColor(input.screenMode === "history"),
      title: paneTitle(
        input.historyPaneLabels.header,
        input.screenMode === "history",
      ),
    },
    input: {
      backgroundColor: paneBackgroundColor(
        input.screenMode === "run" ||
          (input.screenMode === "history" && input.focusPane === "input"),
      ),
      borderColor: paneBorderColor(
        input.screenMode === "run" ||
          (input.screenMode === "history" && input.focusPane === "input"),
      ),
      title:
        input.screenMode === "run"
          ? paneTitle(
              `Run Input (${input.inputMode}${inputSyntaxSuffix})`,
              true,
            )
          : paneTitle(
              `Input (${input.inputMode}${inputSyntaxSuffix})`,
              input.screenMode === "history" && input.focusPane === "input",
            ),
    },
    node: {
      backgroundColor: paneBackgroundColor(
        input.screenMode === "history" && input.focusPane === "nodes",
      ),
      borderColor: paneBorderColor(
        input.screenMode === "history" && input.focusPane === "nodes",
      ),
      title: paneTitle(
        input.historyPaneLabels.right,
        input.screenMode === "history" && input.focusPane === "nodes",
      ),
    },
    runStatus: {
      backgroundColor: "transparent",
      borderColor: paneBorderColor(input.screenMode === "run"),
      title: paneTitle("Execution Status", input.screenMode === "run"),
    },
    runWorkflow: {
      backgroundColor: "transparent",
      borderColor: paneBorderColor(input.screenMode === "run"),
      title: paneTitle("Workflow Detail", input.screenMode === "run"),
    },
    selectorPreview: {
      backgroundColor: "transparent",
      borderColor: paneBorderColor(
        input.screenMode === "workspace" && !workspaceWorkflowsActive,
      ),
      title: paneTitle(
        "Workflow Preview",
        input.screenMode === "workspace" && !workspaceWorkflowsActive,
      ),
    },
    session: {
      backgroundColor: paneBackgroundColor(
        input.screenMode === "history" && input.focusPane === "sessions",
      ),
      borderColor: paneBorderColor(
        input.screenMode === "history" && input.focusPane === "sessions",
      ),
      title: paneTitle(
        input.historyPaneLabels.left,
        input.screenMode === "history" && input.focusPane === "sessions",
      ),
    },
    workflow: {
      backgroundColor: paneBackgroundColor(workspaceWorkflowsActive),
      borderColor: paneBorderColor(workspaceWorkflowsActive),
      title: paneTitle("Workflows", workspaceWorkflowsActive),
    },
  };
}

export function buildWorkflowRunStatusContent(input: {
  readonly completionResult?: {
    readonly exitCode: number;
    readonly sessionId: string;
    readonly status: WorkflowSessionState["status"];
  };
  readonly loadedWorkflow: LoadedWorkflow | undefined;
  readonly runtimeSessionView: RuntimeSessionView | undefined;
  readonly sessionId?: string;
  readonly statusError?: string;
}): string {
  if (input.loadedWorkflow === undefined) {
    return "Select a workflow before starting a run.";
  }

  if (input.runtimeSessionView === undefined) {
    return [
      `Workflow: ${input.loadedWorkflow.workflowName}`,
      `Input mode: ${detectWorkflowInputMode(input.loadedWorkflow).mode}`,
      `Pending session: ${input.sessionId ?? "(not started)"}`,
      input.statusError ?? "No run started yet.",
      "Press enter or ctrl-m from the input area to review and confirm the launch.",
    ].join("\n");
  }

  const session = input.runtimeSessionView.session;
  const finalResult = resolveWorkflowFinalResult(input.runtimeSessionView);

  return [
    `Workflow: ${session.workflowName}`,
    `Session: ${session.sessionId} status=${session.status}`,
    `Current node: ${session.currentNodeId ?? "-"}`,
    `Queue: ${session.queue.join(",") || "-"}`,
    `Node executions: ${String(session.nodeExecutions.length)}`,
    ...(session.lastError === undefined
      ? []
      : [`Last error: ${session.lastError}`]),
    ...(input.statusError === undefined
      ? []
      : [`Status refresh note: ${input.statusError}`]),
    ...(input.completionResult === undefined
      ? []
      : [
          `Completion: exitCode=${String(
            input.completionResult.exitCode,
          )} status=${input.completionResult.status}`,
        ]),
    "",
    "Recent logs:",
    formatLogEntries(input.runtimeSessionView.nodeLogs, 18),
    ...(finalResult === undefined
      ? []
      : ["", "Final result:", compactJson(finalResult, 4_000)]),
  ].join("\n");
}

export function buildWorkflowHistoryStatusMessage(input: {
  readonly busy: boolean;
  readonly detailMode: DetailMode;
  readonly editingInput: boolean;
  readonly filterText: string;
  readonly focusPane: FocusPane;
  readonly inputSyntax: TuiWorkflowInputSyntax;
  readonly matchesCount: number;
  readonly screenMode: ScreenMode;
  readonly workflowCount: number;
  readonly workflowInputDetection: TuiWorkflowInputDetection;
  readonly historyViewMode: HistoryViewMode;
  readonly message: string;
  readonly workflowName?: string;
}): string {
  if (input.screenMode === "workspace") {
    return [
      input.message,
      "",
      `Screen=workspace  Filter=${input.filterText.length === 0 ? "(none)" : input.filterText}  Matches=${String(
        input.matchesCount,
      )}/${String(input.workflowCount)}  Busy=${String(input.busy)}`,
      "j/k: move  /: filter  y: copy workflow id  enter or l: history  ctrl-m: new run  r: refresh  ?: help  q: quit",
      "",
      "Press q to close this popup.",
    ].join("\n");
  }
  if (input.screenMode === "run") {
    return [
      input.message,
      "",
      `Screen=run  Workflow=${input.workflowName ?? "-"}  InputMode=${input.workflowInputDetection.mode}  InputSyntax=${input.inputSyntax.summary}  Busy=${String(
        input.busy,
      )}`,
      "Type into the input editor. enter/ctrl-m: confirm run  f: format JSON  m: toggle input mode",
      "l: open history  h: workspace  r: refresh status  ?: help  q: quit",
      "",
      "Press q to close this popup.",
    ].join("\n");
  }
  return [
    input.message,
    "",
    `Screen=history/${input.historyViewMode}  Focus=${input.focusPane}  Detail=${input.detailMode}  InputMode=${input.workflowInputDetection.mode}  Editing=${String(
      input.editingInput,
    )}  Busy=${String(input.busy)}`,
    `Input syntax=${input.inputSyntax.summary}`,
    "tab/shift-tab: cycle sessions -> nodes -> detail -> input  enter/ctrl-m: load selection  e: edit input  f: format JSON  m: toggle input mode",
    "nodes: enter/ctrl-m to node detail  node detail: j/k or arrows stay in-pane, enter/ctrl-m opens the selected JSON viewer or AI session popup, esc returns to nodes",
    "n: open new-run screen  y: copy focused id  R: rerun selected node  u: resume selected session  i/o/g/a/s: change detail view",
    input.historyViewMode === "workflow"
      ? "l: workflow runs -> nodes, subworkflow row -> subworkflow view  h: nodes -> workflow runs, workflow runs -> workspace  r: refresh  ?: help  q: quit"
      : "l: workflow nodes -> workflow list, workflow list -> child subworkflow  h: workflow list -> workflow nodes, workflow nodes -> parent view  r: refresh  ?: help  q: quit",
    "",
    "Press q to close this popup.",
  ].join("\n");
}
