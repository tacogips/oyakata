import { AdapterExecutionError, type AdapterExecutionOutput } from "./adapter";
import { renderPromptTemplate } from "./render";
import { resolveNodeExecutionWorkingDirectory } from "./working-directory";
import {
  DEFAULT_MAIL_GATEWAY_IMAGE,
  DEFAULT_X_GATEWAY_IMAGE,
} from "./node-addons";
import {
  getSuperviserControlAddonProviderOperationId,
  isSuperviserControlAddonName,
} from "./types";
import type {
  ChatReplyDispatchRequest,
  ChatReplyDispatchTarget,
  ChatReplyWorkerConfig,
  ContainerRunnerKind,
  JsonObject,
  ResolvedMailGatewayAddon,
  ResolvedMailGatewayReadAddon,
  ResolvedChatReplyWorkerAddon,
  ResolvedXGatewayAddon,
  ResolvedXGatewayReadAddon,
  ResolvedSuperviserControlAddon,
  WorkflowNodeAddonEnvBinding,
} from "./types";
import { executeSuperviserControlNativeOperation } from "./superviser-control";
import {
  type NativeNodeExecutionInput,
  type NativeNodeExecutionContext,
  buildNativeOutput,
  buildProcessLogAttachments,
  mergeProcessLogsIntoAdapterError,
  runLoggedSpawnedProcess,
  appendContainerEnvNameArgs,
  buildRunnerEnv,
  resolveTemplateVariables,
} from "./native-node-executor-process";

const X_GATEWAY_READ_BINARY = "x-gateway-reader";
const X_GATEWAY_BINARY = "x-gateway";
const MAIL_GATEWAY_READ_BINARY = "mail-gateway-reader";
const MAIL_GATEWAY_BINARY = "mail-gateway";

function isContainerRunnerWithDockerCli(
  runnerKind: ContainerRunnerKind,
): runnerKind is "podman" | "docker" | "nerdctl" {
  return (
    runnerKind === "podman" ||
    runnerKind === "docker" ||
    runnerKind === "nerdctl"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function resolveChatReplyTarget(
  runtimeVariables: Readonly<Record<string, unknown>>,
): ChatReplyDispatchTarget | null {
  const event = runtimeVariables["event"];
  if (!isRecord(event)) {
    return null;
  }

  const replyTarget = event["replyTarget"];
  if (isRecord(replyTarget)) {
    const sourceId = readOptionalString(replyTarget, "sourceId");
    const provider = readOptionalString(replyTarget, "provider");
    const eventId = readOptionalString(replyTarget, "eventId");
    const conversationId = readOptionalString(replyTarget, "conversationId");
    if (
      sourceId !== undefined &&
      provider !== undefined &&
      eventId !== undefined &&
      conversationId !== undefined
    ) {
      const threadId = readOptionalString(replyTarget, "threadId");
      const actorId = readOptionalString(replyTarget, "actorId");
      return {
        sourceId,
        provider,
        eventId,
        conversationId,
        ...(threadId === undefined ? {} : { threadId }),
        ...(actorId === undefined ? {} : { actorId }),
      };
    }
  }

  const sourceId = readOptionalString(event, "sourceId");
  const provider = readOptionalString(event, "provider");
  const eventId = readOptionalString(event, "eventId");
  const conversation = event["conversation"];
  if (
    sourceId === undefined ||
    provider === undefined ||
    eventId === undefined ||
    !isRecord(conversation)
  ) {
    return null;
  }

  const conversationId = readOptionalString(conversation, "id");
  if (conversationId === undefined) {
    return null;
  }

  const actor = event["actor"];
  const threadId = readOptionalString(conversation, "threadId");
  const actorId = isRecord(actor) ? readOptionalString(actor, "id") : undefined;
  return {
    sourceId,
    provider,
    eventId,
    conversationId,
    ...(threadId === undefined ? {} : { threadId }),
    ...(actorId === undefined ? {} : { actorId }),
  };
}

function buildFallbackReplyTarget(input: {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly nodeId: string;
}): ChatReplyDispatchTarget {
  return {
    sourceId: "missing",
    provider: "missing",
    eventId: input.workflowExecutionId,
    conversationId: `${input.workflowId}/${input.nodeId}`,
  };
}

function targetToJson(target: ChatReplyDispatchTarget): JsonObject {
  return {
    sourceId: target.sourceId,
    provider: target.provider,
    eventId: target.eventId,
    conversationId: target.conversationId,
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    ...(target.actorId === undefined ? {} : { actorId: target.actorId }),
  };
}

function resolveChatReplyStatus(input: {
  readonly target: ChatReplyDispatchTarget | null;
  readonly config: ChatReplyWorkerConfig;
}): "intent-only" | "dry-run" {
  if (input.target !== null) {
    return "intent-only";
  }
  return input.config.onMissingTarget === "dry-run" ? "dry-run" : "intent-only";
}

function buildChatReplyDispatchRequest(input: {
  readonly target: ChatReplyDispatchTarget;
  readonly text: string;
  readonly addon: ResolvedChatReplyWorkerAddon;
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly nodeId: string;
  readonly nodeExecId: string;
  readonly idempotencyKey: string;
}): ChatReplyDispatchRequest {
  return {
    target: input.target,
    message: { text: input.text },
    visibility: input.addon.config.visibility ?? "public",
    threadPolicy: input.addon.config.threadPolicy ?? "same-thread",
    idempotencyKey: input.idempotencyKey,
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    nodeId: input.nodeId,
    nodeExecId: input.nodeExecId,
  };
}

function buildChatReplyIdempotencyKey(input: {
  readonly workflowId: string;
  readonly workflowExecutionId: string;
  readonly nodeId: string;
  readonly nodeExecId: string;
}): string {
  return [
    "chat-reply",
    input.workflowId,
    input.workflowExecutionId,
    input.nodeId,
    input.nodeExecId,
  ].join(":");
}

async function executeChatReplyAddonNode(
  input: NativeNodeExecutionInput,
  addon: ResolvedChatReplyWorkerAddon,
): Promise<AdapterExecutionOutput> {
  const variables = resolveTemplateVariables(input);
  const renderedText = renderPromptTemplate(
    addon.config.textTemplate,
    variables,
  ).trim();
  if (renderedText.length === 0) {
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' rendered an empty chat reply`,
    );
  }

  const target = resolveChatReplyTarget(input.runtimeVariables);
  const onMissingTarget = addon.config.onMissingTarget ?? "fail";
  if (target === null && onMissingTarget === "fail") {
    throw new AdapterExecutionError(
      "provider_error",
      `node '${input.nodeId}' cannot reply because runtimeVariables.event does not include a chat conversation target`,
    );
  }

  const effectiveTarget =
    target ??
    buildFallbackReplyTarget({
      workflowId: input.workflowId,
      workflowExecutionId: input.workflowExecutionId,
      nodeId: input.nodeId,
    });
  const idempotencyKey = buildChatReplyIdempotencyKey({
    workflowId: input.workflowId,
    workflowExecutionId: input.workflowExecutionId,
    nodeId: input.nodeId,
    nodeExecId: input.nodeExecId,
  });
  const dispatchResult =
    target === null || input.chatReplyDispatcher === undefined
      ? undefined
      : await input.chatReplyDispatcher.dispatchChatReply(
          buildChatReplyDispatchRequest({
            target,
            text: renderedText,
            addon,
            workflowId: input.workflowId,
            workflowExecutionId: input.workflowExecutionId,
            nodeId: input.nodeId,
            nodeExecId: input.nodeExecId,
            idempotencyKey,
          }),
        );
  const status =
    dispatchResult?.status ??
    resolveChatReplyStatus({
      target,
      config: addon.config,
    });

  return {
    provider: "native-addon",
    model: `${addon.name}@${addon.version}`,
    promptText: addon.config.textTemplate,
    completionPassed: true,
    when: {
      always: true,
      replied: status !== "dry-run",
      dryRun: status === "dry-run",
    },
    payload: {
      reply: {
        status,
        target: targetToJson(effectiveTarget),
        message: { text: renderedText },
        visibility: addon.config.visibility ?? "public",
        threadPolicy: addon.config.threadPolicy ?? "same-thread",
        idempotencyKey,
        ...(dispatchResult === undefined
          ? {}
          : {
              dispatch: {
                provider: dispatchResult.provider,
                status: dispatchResult.status,
                ...(dispatchResult.dispatchId === undefined
                  ? {}
                  : { dispatchId: dispatchResult.dispatchId }),
                ...(dispatchResult.providerMessageId === undefined
                  ? {}
                  : { providerMessageId: dispatchResult.providerMessageId }),
              },
            }),
      },
    },
  };
}

function resolveAddonEnv(input: {
  readonly addonName: string;
  readonly nodeId: string;
  readonly bindings: Readonly<Record<string, WorkflowNodeAddonEnvBinding>>;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, string>> {
  const sourceEnv = input.sourceEnv ?? process.env;
  const resolved: Record<string, string> = {};
  for (const [targetEnv, binding] of Object.entries(input.bindings)) {
    const value = sourceEnv[binding.fromEnv];
    if (value === undefined || value.length === 0) {
      if (binding.required === false) {
        continue;
      }
      throw new AdapterExecutionError(
        "provider_error",
        `node '${input.nodeId}' cannot run ${input.addonName} because required environment variable '${binding.fromEnv}' is not set for add-on env '${targetEnv}'`,
      );
    }
    resolved[targetEnv] = value;
  }
  return resolved;
}

function parseXGatewayJsonOutput(input: {
  readonly stdout: string;
  readonly nodeId: string;
}): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout) as unknown;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' x-gateway output must be valid JSON: ${message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' x-gateway output must be a JSON object`,
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function resolveXGatewayRunner(input: {
  readonly addon: ResolvedXGatewayReadAddon | ResolvedXGatewayAddon;
  readonly defaults: import("./types").WorkflowDefaults["containerRuntime"];
}): {
  readonly runnerKind: ContainerRunnerKind;
  readonly runnerCommand: string;
} {
  const runnerKind =
    input.addon.config.runnerKind ?? input.defaults?.runnerKind ?? "podman";
  if (!isContainerRunnerWithDockerCli(runnerKind)) {
    throw new AdapterExecutionError(
      "policy_blocked",
      `container runner '${runnerKind}' is not supported for ${input.addon.name}`,
    );
  }
  return {
    runnerKind,
    runnerCommand:
      input.addon.config.runnerPath ?? input.defaults?.runnerPath ?? runnerKind,
  };
}

function parseMailGatewayJsonOutput(input: {
  readonly stdout: string;
  readonly nodeId: string;
}): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout) as unknown;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' mail-gateway output must be valid JSON: ${message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' mail-gateway output must be a JSON object`,
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function resolveMailGatewayRunner(input: {
  readonly addon: ResolvedMailGatewayReadAddon | ResolvedMailGatewayAddon;
  readonly defaults: import("./types").WorkflowDefaults["containerRuntime"];
}): {
  readonly runnerKind: ContainerRunnerKind;
  readonly runnerCommand: string;
} {
  const runnerKind =
    input.addon.config.runnerKind ?? input.defaults?.runnerKind ?? "podman";
  if (!isContainerRunnerWithDockerCli(runnerKind)) {
    throw new AdapterExecutionError(
      "policy_blocked",
      `container runner '${runnerKind}' is not supported for ${input.addon.name}`,
    );
  }
  return {
    runnerKind,
    runnerCommand:
      input.addon.config.runnerPath ?? input.defaults?.runnerPath ?? runnerKind,
  };
}

async function executeXGatewayReadAddonNode(
  input: NativeNodeExecutionInput,
  addon: ResolvedXGatewayReadAddon,
  context: NativeNodeExecutionContext,
): Promise<AdapterExecutionOutput> {
  const variables = resolveTemplateVariables(input);
  const renderedQuery = renderPromptTemplate(
    addon.config.queryTemplate,
    variables,
  ).trim();
  if (renderedQuery.length === 0) {
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' rendered an empty x-gateway query`,
    );
  }

  const mappedEnv =
    addon.env === undefined
      ? {}
      : resolveAddonEnv({
          addonName: addon.name,
          nodeId: input.nodeId,
          bindings: addon.env,
          ...(input.env === undefined ? {} : { sourceEnv: input.env }),
        });
  const { runnerKind, runnerCommand } = resolveXGatewayRunner({
    addon,
    defaults: input.workflowDefaults.containerRuntime,
  });
  const image = addon.config.image ?? DEFAULT_X_GATEWAY_IMAGE;
  const runArgs = ["run", "--rm"];
  if (addon.config.networkPolicy === "disabled") {
    runArgs.push("--network", "none");
  }
  appendContainerEnvNameArgs(runArgs, mappedEnv);
  runArgs.push(
    image,
    X_GATEWAY_READ_BINARY,
    "graphql",
    "query",
    renderedQuery,
    "--json",
  );

  const result = await runLoggedSpawnedProcess({
    command: runnerCommand,
    args: runArgs,
    cwd: resolveNodeExecutionWorkingDirectory(
      input.workflowWorkingDirectory,
      input.node.workingDirectory,
    ),
    env: {
      ...buildRunnerEnv({
        ...(input.env === undefined ? {} : { ambientEnv: input.env }),
      }),
      ...mappedEnv,
    },
    context,
    artifactDir: input.artifactDir,
  });
  const processLogs = buildProcessLogAttachments(result);

  try {
    return buildNativeOutput({
      provider: `native-addon:x-gateway-read:${runnerKind}`,
      model: image,
      promptText: renderedQuery,
      payload: {
        xGateway: parseXGatewayJsonOutput({
          stdout: result.stdout,
          nodeId: input.nodeId,
        }),
      },
      processLogs,
    });
  } catch (error: unknown) {
    throw mergeProcessLogsIntoAdapterError(error, processLogs);
  }
}

async function executeXGatewayAddonNode(
  input: NativeNodeExecutionInput,
  addon: ResolvedXGatewayAddon,
  context: NativeNodeExecutionContext,
): Promise<AdapterExecutionOutput> {
  const variables = resolveTemplateVariables(input);
  const renderedDocument = renderPromptTemplate(
    addon.config.documentTemplate,
    variables,
  ).trim();
  if (renderedDocument.length === 0) {
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' rendered an empty x-gateway document`,
    );
  }

  const mappedEnv =
    addon.env === undefined
      ? {}
      : resolveAddonEnv({
          addonName: addon.name,
          nodeId: input.nodeId,
          bindings: addon.env,
          ...(input.env === undefined ? {} : { sourceEnv: input.env }),
        });
  const { runnerKind, runnerCommand } = resolveXGatewayRunner({
    addon,
    defaults: input.workflowDefaults.containerRuntime,
  });
  const image = addon.config.image ?? DEFAULT_X_GATEWAY_IMAGE;
  const runArgs = ["run", "--rm"];
  if (addon.config.networkPolicy === "disabled") {
    runArgs.push("--network", "none");
  }
  appendContainerEnvNameArgs(runArgs, mappedEnv);
  runArgs.push(
    image,
    X_GATEWAY_BINARY,
    "graphql",
    "query",
    renderedDocument,
    "--json",
  );

  const result = await runLoggedSpawnedProcess({
    command: runnerCommand,
    args: runArgs,
    cwd: resolveNodeExecutionWorkingDirectory(
      input.workflowWorkingDirectory,
      input.node.workingDirectory,
    ),
    env: {
      ...buildRunnerEnv({
        ...(input.env === undefined ? {} : { ambientEnv: input.env }),
      }),
      ...mappedEnv,
    },
    context,
    artifactDir: input.artifactDir,
  });
  const processLogs = buildProcessLogAttachments(result);

  try {
    return buildNativeOutput({
      provider: `native-addon:x-gateway:${runnerKind}`,
      model: image,
      promptText: renderedDocument,
      payload: {
        xGateway: parseXGatewayJsonOutput({
          stdout: result.stdout,
          nodeId: input.nodeId,
        }),
      },
      processLogs,
    });
  } catch (error: unknown) {
    throw mergeProcessLogsIntoAdapterError(error, processLogs);
  }
}

async function executeMailGatewayReadAddonNode(
  input: NativeNodeExecutionInput,
  addon: ResolvedMailGatewayReadAddon,
  context: NativeNodeExecutionContext,
): Promise<AdapterExecutionOutput> {
  const variables = resolveTemplateVariables(input);
  const renderedQuery = renderPromptTemplate(
    addon.config.queryTemplate,
    variables,
  ).trim();
  if (renderedQuery.length === 0) {
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' rendered an empty mail-gateway query`,
    );
  }

  const mappedEnv =
    addon.env === undefined
      ? {}
      : resolveAddonEnv({
          addonName: addon.name,
          nodeId: input.nodeId,
          bindings: addon.env,
          ...(input.env === undefined ? {} : { sourceEnv: input.env }),
        });
  const { runnerKind, runnerCommand } = resolveMailGatewayRunner({
    addon,
    defaults: input.workflowDefaults.containerRuntime,
  });
  const image = addon.config.image ?? DEFAULT_MAIL_GATEWAY_IMAGE;
  const runArgs = ["run", "--rm"];
  if (addon.config.networkPolicy === "disabled") {
    runArgs.push("--network", "none");
  }
  appendContainerEnvNameArgs(runArgs, mappedEnv);
  runArgs.push(
    image,
    MAIL_GATEWAY_READ_BINARY,
    "graphql",
    "--query",
    renderedQuery,
  );

  const result = await runLoggedSpawnedProcess({
    command: runnerCommand,
    args: runArgs,
    cwd: resolveNodeExecutionWorkingDirectory(
      input.workflowWorkingDirectory,
      input.node.workingDirectory,
    ),
    env: {
      ...buildRunnerEnv({
        ...(input.env === undefined ? {} : { ambientEnv: input.env }),
      }),
      ...mappedEnv,
    },
    context,
    artifactDir: input.artifactDir,
  });
  const processLogs = buildProcessLogAttachments(result);

  try {
    return buildNativeOutput({
      provider: `native-addon:mail-gateway-read:${runnerKind}`,
      model: image,
      promptText: renderedQuery,
      payload: {
        mailGateway: parseMailGatewayJsonOutput({
          stdout: result.stdout,
          nodeId: input.nodeId,
        }),
      },
      processLogs,
    });
  } catch (error: unknown) {
    throw mergeProcessLogsIntoAdapterError(error, processLogs);
  }
}

async function executeMailGatewayAddonNode(
  input: NativeNodeExecutionInput,
  addon: ResolvedMailGatewayAddon,
  context: NativeNodeExecutionContext,
): Promise<AdapterExecutionOutput> {
  const variables = resolveTemplateVariables(input);
  const renderedDocument = renderPromptTemplate(
    addon.config.documentTemplate,
    variables,
  ).trim();
  if (renderedDocument.length === 0) {
    throw new AdapterExecutionError(
      "invalid_output",
      `node '${input.nodeId}' rendered an empty mail-gateway document`,
    );
  }

  const mappedEnv =
    addon.env === undefined
      ? {}
      : resolveAddonEnv({
          addonName: addon.name,
          nodeId: input.nodeId,
          bindings: addon.env,
          ...(input.env === undefined ? {} : { sourceEnv: input.env }),
        });
  const { runnerKind, runnerCommand } = resolveMailGatewayRunner({
    addon,
    defaults: input.workflowDefaults.containerRuntime,
  });
  const image = addon.config.image ?? DEFAULT_MAIL_GATEWAY_IMAGE;
  const runArgs = ["run", "--rm"];
  if (addon.config.networkPolicy === "disabled") {
    runArgs.push("--network", "none");
  }
  appendContainerEnvNameArgs(runArgs, mappedEnv);
  runArgs.push(
    image,
    MAIL_GATEWAY_BINARY,
    "graphql",
    "--query",
    renderedDocument,
  );

  const result = await runLoggedSpawnedProcess({
    command: runnerCommand,
    args: runArgs,
    cwd: resolveNodeExecutionWorkingDirectory(
      input.workflowWorkingDirectory,
      input.node.workingDirectory,
    ),
    env: {
      ...buildRunnerEnv({
        ...(input.env === undefined ? {} : { ambientEnv: input.env }),
      }),
      ...mappedEnv,
    },
    context,
    artifactDir: input.artifactDir,
  });
  const processLogs = buildProcessLogAttachments(result);

  try {
    return buildNativeOutput({
      provider: `native-addon:mail-gateway:${runnerKind}`,
      model: image,
      promptText: renderedDocument,
      payload: {
        mailGateway: parseMailGatewayJsonOutput({
          stdout: result.stdout,
          nodeId: input.nodeId,
        }),
      },
      processLogs,
    });
  } catch (error: unknown) {
    throw mergeProcessLogsIntoAdapterError(error, processLogs);
  }
}

async function executeSuperviserControlAddonNode(
  input: NativeNodeExecutionInput,
  addon: ResolvedSuperviserControlAddon,
): Promise<AdapterExecutionOutput> {
  if (input.superviserControl === undefined) {
    throw new AdapterExecutionError(
      "policy_blocked",
      `node '${input.nodeId}' add-on '${addon.name}' requires nested superviser runtime control (phase-2 --auto-improve); this add-on is not available in the current execution context`,
    );
  }
  const result = await executeSuperviserControlNativeOperation({
    addonName: addon.name,
    arguments: input.arguments,
    control: input.superviserControl,
    nodeId: input.nodeId,
  });
  if (!result.ok) {
    throw new AdapterExecutionError("provider_error", result.error);
  }
  return buildNativeOutput({
    provider: `native-addon:superviser-control/${getSuperviserControlAddonProviderOperationId(addon.name)}`,
    model: addon.name,
    promptText: "superviser-control",
    payload: { superviser: result.value },
  });
}

export async function executeAddonNode(
  input: NativeNodeExecutionInput,
  context: NativeNodeExecutionContext,
): Promise<AdapterExecutionOutput> {
  const addon = input.node.addon;
  if (addon === undefined) {
    throw new AdapterExecutionError(
      "policy_blocked",
      `node '${input.nodeId}' does not declare a resolved add-on executor`,
    );
  }
  if (isSuperviserControlAddonName(addon.name)) {
    return await executeSuperviserControlAddonNode(
      input,
      addon as ResolvedSuperviserControlAddon,
    );
  }
  switch (addon.name) {
    case "divedra/chat-reply-worker":
      return await executeChatReplyAddonNode(input, addon);
    case "divedra/x-gateway-read":
      return await executeXGatewayReadAddonNode(input, addon, context);
    case "divedra/x-gateway":
      return await executeXGatewayAddonNode(input, addon, context);
    case "divedra/mail-gateway-read":
      return await executeMailGatewayReadAddonNode(input, addon, context);
    case "divedra/mail-gateway":
      return await executeMailGatewayAddonNode(input, addon, context);
    default:
      throw new AdapterExecutionError(
        "policy_blocked",
        `node '${input.nodeId}' declares add-on '${addon.name}' that does not use a native add-on executor`,
      );
  }
}
