import type {
  AgentWorkerAddonConfig,
  CliAgentBackend,
  ChatReplyWorkerConfig,
  MailGatewayAddonConfig,
  MailGatewayReadAddonConfig,
  NodeAddonResolveInput,
  NodeAddonResolveResult,
  NodeOutputContract,
  NodePayload,
  ResolvedNodeAddon,
  ResolvedSuperviserControlAddon,
  SuperviserControlAddonName,
  ValidationIssue,
  WorkflowNodeAddonRef,
  XGatewayAddonConfig,
  XGatewayReadAddonConfig,
} from "./types";
import {
  describeSuperviserControlAddon,
  isSuperviserControlAddonName,
} from "./types";
import {
  CHAT_REPLY_WORKER_ADDON_NAME,
  CHAT_REPLY_WORKER_ADDON_VERSION,
  CHAT_REPLY_WORKER_OUTPUT,
  CODEX_WORKER_ADDON_NAME,
  CLAUDE_CODE_WORKER_ADDON_NAME,
  AGENT_WORKER_ADDON_VERSION,
  X_GATEWAY_ADDON_NAME,
  X_GATEWAY_ADDON_VERSION,
  X_GATEWAY_READ_ADDON_NAME,
  X_GATEWAY_READ_ADDON_VERSION,
  MAIL_GATEWAY_ADDON_NAME,
  MAIL_GATEWAY_ADDON_VERSION,
  MAIL_GATEWAY_READ_ADDON_NAME,
  MAIL_GATEWAY_READ_ADDON_VERSION,
  SUPERVISER_CONTROL_ADDON_VERSION,
  SUPERVISER_CONTROL_ADDON_OUTPUT,
  X_GATEWAY_READ_OUTPUT,
  X_GATEWAY_OUTPUT,
  MAIL_GATEWAY_READ_OUTPUT,
  MAIL_GATEWAY_OUTPUT,
  makeIssue,
  isRecord,
  readOptionalStringConfig,
  readRequiredStringConfig,
  normalizeSessionPolicy,
} from "./node-addons-constants";

function normalizeChatReplyWorkerConfig(
  value: Readonly<Record<string, unknown>> | undefined,
  path: string,
): {
  readonly config?: ChatReplyWorkerConfig;
  readonly issues: readonly ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const config: Readonly<Record<string, unknown>> = value ?? {};
  const allowedKeys = new Set([
    "textTemplate",
    "visibility",
    "threadPolicy",
    "onMissingTarget",
  ]);

  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      issues.push(makeIssue(`${path}.${key}`, "is not supported"));
    }
  }

  const textTemplate = config["textTemplate"];
  if (typeof textTemplate !== "string" || textTemplate.trim().length === 0) {
    issues.push(
      makeIssue(`${path}.textTemplate`, "must be a non-empty string"),
    );
  }

  const visibility = config["visibility"];
  if (
    visibility !== undefined &&
    visibility !== "public" &&
    visibility !== "ephemeral"
  ) {
    issues.push(
      makeIssue(`${path}.visibility`, "must be 'public' or 'ephemeral'"),
    );
  }

  const threadPolicy = config["threadPolicy"];
  if (
    threadPolicy !== undefined &&
    threadPolicy !== "same-thread" &&
    threadPolicy !== "conversation-root"
  ) {
    issues.push(
      makeIssue(
        `${path}.threadPolicy`,
        "must be 'same-thread' or 'conversation-root'",
      ),
    );
  }

  const onMissingTarget = config["onMissingTarget"];
  if (
    onMissingTarget !== undefined &&
    onMissingTarget !== "fail" &&
    onMissingTarget !== "intent-only" &&
    onMissingTarget !== "dry-run"
  ) {
    issues.push(
      makeIssue(
        `${path}.onMissingTarget`,
        "must be 'fail', 'intent-only', or 'dry-run'",
      ),
    );
  }

  if (issues.length > 0 || typeof textTemplate !== "string") {
    return { issues };
  }
  const normalizedVisibility =
    visibility === "public" || visibility === "ephemeral"
      ? visibility
      : undefined;
  const normalizedThreadPolicy =
    threadPolicy === "same-thread" || threadPolicy === "conversation-root"
      ? threadPolicy
      : undefined;
  const normalizedOnMissingTarget =
    onMissingTarget === "fail" ||
    onMissingTarget === "intent-only" ||
    onMissingTarget === "dry-run"
      ? onMissingTarget
      : undefined;

  return {
    config: {
      textTemplate,
      ...(normalizedVisibility === undefined
        ? {}
        : { visibility: normalizedVisibility }),
      ...(normalizedThreadPolicy === undefined
        ? {}
        : { threadPolicy: normalizedThreadPolicy }),
      ...(normalizedOnMissingTarget === undefined
        ? {}
        : { onMissingTarget: normalizedOnMissingTarget }),
    },
    issues,
  };
}

type GatewayTemplateKey = "queryTemplate" | "documentTemplate";

interface GatewayContainerConfigFields {
  readonly image?: string;
  readonly runnerKind?: "podman" | "docker" | "nerdctl";
  readonly runnerPath?: string;
  readonly networkPolicy?: "disabled" | "egress-allowed";
}

interface QueryGatewayConfig extends GatewayContainerConfigFields {
  readonly queryTemplate: string;
}

interface DocumentGatewayConfig extends GatewayContainerConfigFields {
  readonly documentTemplate: string;
}

function buildGatewayContainerConfig(
  input: GatewayContainerConfigFields,
): GatewayContainerConfigFields {
  return {
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.runnerKind === undefined ? {} : { runnerKind: input.runnerKind }),
    ...(input.runnerPath === undefined ? {} : { runnerPath: input.runnerPath }),
    ...(input.networkPolicy === undefined
      ? {}
      : { networkPolicy: input.networkPolicy }),
  };
}

function normalizeGatewayTemplateConfig(
  value: Readonly<Record<string, unknown>> | undefined,
  path: string,
  templateKey: "queryTemplate",
): {
  readonly config?: QueryGatewayConfig;
  readonly issues: readonly ValidationIssue[];
};
function normalizeGatewayTemplateConfig(
  value: Readonly<Record<string, unknown>> | undefined,
  path: string,
  templateKey: "documentTemplate",
): {
  readonly config?: DocumentGatewayConfig;
  readonly issues: readonly ValidationIssue[];
};
function normalizeGatewayTemplateConfig(
  value: Readonly<Record<string, unknown>> | undefined,
  path: string,
  templateKey: GatewayTemplateKey,
): {
  readonly config?: QueryGatewayConfig | DocumentGatewayConfig;
  readonly issues: readonly ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const config: Readonly<Record<string, unknown>> = value ?? {};
  const allowedKeys = new Set([
    templateKey,
    "image",
    "runnerKind",
    "runnerPath",
    "networkPolicy",
  ]);

  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      issues.push(makeIssue(`${path}.${key}`, "is not supported"));
    }
  }

  const template = readRequiredStringConfig(config, templateKey, path, issues);
  const image = readOptionalStringConfig(config, "image", path, issues);
  const runnerPath = readOptionalStringConfig(
    config,
    "runnerPath",
    path,
    issues,
  );

  const runnerKindRaw = config["runnerKind"];
  let runnerKind: XGatewayReadAddonConfig["runnerKind"];
  if (runnerKindRaw !== undefined) {
    if (
      runnerKindRaw === "podman" ||
      runnerKindRaw === "docker" ||
      runnerKindRaw === "nerdctl"
    ) {
      runnerKind = runnerKindRaw;
    } else {
      issues.push(
        makeIssue(
          `${path}.runnerKind`,
          "must be 'podman', 'docker', or 'nerdctl'",
        ),
      );
    }
  }

  const networkPolicyRaw = config["networkPolicy"];
  let networkPolicy: XGatewayReadAddonConfig["networkPolicy"];
  if (networkPolicyRaw !== undefined) {
    if (
      networkPolicyRaw === "disabled" ||
      networkPolicyRaw === "egress-allowed"
    ) {
      networkPolicy = networkPolicyRaw;
    } else {
      issues.push(
        makeIssue(
          `${path}.networkPolicy`,
          "must be 'disabled' or 'egress-allowed'",
        ),
      );
    }
  }

  if (issues.length > 0 || template === undefined) {
    return { issues };
  }

  const containerConfig = buildGatewayContainerConfig({
    ...(image === undefined ? {} : { image }),
    ...(runnerKind === undefined ? {} : { runnerKind }),
    ...(runnerPath === undefined ? {} : { runnerPath }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
  });

  if (templateKey === "queryTemplate") {
    return {
      config: {
        queryTemplate: template,
        ...containerConfig,
      },
      issues,
    };
  }

  return {
    config: {
      documentTemplate: template,
      ...containerConfig,
    },
    issues,
  };
}

type GatewayConfigNormalizer<Config> = (
  value: Readonly<Record<string, unknown>> | undefined,
  path: string,
) => {
  readonly config?: Config;
  readonly issues: readonly ValidationIssue[];
};

interface BuiltinGatewayAddonDescriptor<Config> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly output: NodeOutputContract;
  readonly normalizeConfig: GatewayConfigNormalizer<Config>;
  readonly createResolvedAddon: (input: {
    readonly config: Config;
    readonly authoredAddon: WorkflowNodeAddonRef;
  }) => ResolvedNodeAddon;
}

function validateGatewayAddonFields(
  addon: WorkflowNodeAddonRef,
  path: string,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (addon.config !== undefined && !isRecord(addon.config)) {
    issues.push(makeIssue(`${path}.config`, "must be an object"));
  }
  if (addon.inputs !== undefined && !isRecord(addon.inputs)) {
    issues.push(makeIssue(`${path}.inputs`, "must be an object"));
  }
  return issues;
}

const X_GATEWAY_READ_DESCRIPTOR: BuiltinGatewayAddonDescriptor<XGatewayReadAddonConfig> =
  {
    name: X_GATEWAY_READ_ADDON_NAME,
    version: X_GATEWAY_READ_ADDON_VERSION,
    description:
      "Built-in worker that runs a read-only x-gateway query in a container.",
    output: X_GATEWAY_READ_OUTPUT,
    normalizeConfig: (v, p) =>
      normalizeGatewayTemplateConfig(v, p, "queryTemplate"),
    createResolvedAddon: ({ config, authoredAddon }) => ({
      name: X_GATEWAY_READ_ADDON_NAME,
      version: X_GATEWAY_READ_ADDON_VERSION,
      config,
      ...(authoredAddon.env === undefined ? {} : { env: authoredAddon.env }),
      ...(authoredAddon.inputs === undefined
        ? {}
        : { inputs: authoredAddon.inputs }),
    }),
  };

const X_GATEWAY_DESCRIPTOR: BuiltinGatewayAddonDescriptor<XGatewayAddonConfig> =
  {
    name: X_GATEWAY_ADDON_NAME,
    version: X_GATEWAY_ADDON_VERSION,
    description:
      "Built-in worker that runs an x-gateway query or mutation in a container.",
    output: X_GATEWAY_OUTPUT,
    normalizeConfig: (v, p) =>
      normalizeGatewayTemplateConfig(v, p, "documentTemplate"),
    createResolvedAddon: ({ config, authoredAddon }) => ({
      name: X_GATEWAY_ADDON_NAME,
      version: X_GATEWAY_ADDON_VERSION,
      config,
      ...(authoredAddon.env === undefined ? {} : { env: authoredAddon.env }),
      ...(authoredAddon.inputs === undefined
        ? {}
        : { inputs: authoredAddon.inputs }),
    }),
  };

const MAIL_GATEWAY_READ_DESCRIPTOR: BuiltinGatewayAddonDescriptor<MailGatewayReadAddonConfig> =
  {
    name: MAIL_GATEWAY_READ_ADDON_NAME,
    version: MAIL_GATEWAY_READ_ADDON_VERSION,
    description:
      "Built-in worker that runs a read-only mail-gateway query in a container.",
    output: MAIL_GATEWAY_READ_OUTPUT,
    normalizeConfig: (v, p) =>
      normalizeGatewayTemplateConfig(v, p, "queryTemplate"),
    createResolvedAddon: ({ config, authoredAddon }) => ({
      name: MAIL_GATEWAY_READ_ADDON_NAME,
      version: MAIL_GATEWAY_READ_ADDON_VERSION,
      config,
      ...(authoredAddon.env === undefined ? {} : { env: authoredAddon.env }),
      ...(authoredAddon.inputs === undefined
        ? {}
        : { inputs: authoredAddon.inputs }),
    }),
  };

const MAIL_GATEWAY_DESCRIPTOR: BuiltinGatewayAddonDescriptor<MailGatewayAddonConfig> =
  {
    name: MAIL_GATEWAY_ADDON_NAME,
    version: MAIL_GATEWAY_ADDON_VERSION,
    description:
      "Built-in worker that runs a mail-gateway query or mutation in a container.",
    output: MAIL_GATEWAY_OUTPUT,
    normalizeConfig: (v, p) =>
      normalizeGatewayTemplateConfig(v, p, "documentTemplate"),
    createResolvedAddon: ({ config, authoredAddon }) => ({
      name: MAIL_GATEWAY_ADDON_NAME,
      version: MAIL_GATEWAY_ADDON_VERSION,
      config,
      ...(authoredAddon.env === undefined ? {} : { env: authoredAddon.env }),
      ...(authoredAddon.inputs === undefined
        ? {}
        : { inputs: authoredAddon.inputs }),
    }),
  };

function normalizeAgentWorkerConfig(
  value: Readonly<Record<string, unknown>> | undefined,
  path: string,
): {
  readonly config?: AgentWorkerAddonConfig;
  readonly issues: readonly ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const config: Readonly<Record<string, unknown>> = value ?? {};
  const allowedKeys = new Set([
    "model",
    "promptTemplate",
    "systemPromptTemplate",
    "sessionStartPromptTemplate",
    "sessionPolicy",
    "timeoutMs",
  ]);

  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      issues.push(makeIssue(`${path}.${key}`, "is not supported"));
    }
  }

  const model = readRequiredStringConfig(config, "model", path, issues);
  const promptTemplate = readRequiredStringConfig(
    config,
    "promptTemplate",
    path,
    issues,
  );
  const systemPromptTemplate = readOptionalStringConfig(
    config,
    "systemPromptTemplate",
    path,
    issues,
  );
  const sessionStartPromptTemplate = readOptionalStringConfig(
    config,
    "sessionStartPromptTemplate",
    path,
    issues,
  );
  const sessionPolicy = normalizeSessionPolicy(
    config["sessionPolicy"],
    `${path}.sessionPolicy`,
    issues,
  );

  const timeoutMsRaw = config["timeoutMs"];
  let timeoutMs: number | undefined;
  if (timeoutMsRaw !== undefined) {
    if (typeof timeoutMsRaw === "number" && timeoutMsRaw > 0) {
      timeoutMs = timeoutMsRaw;
    } else {
      issues.push(makeIssue(`${path}.timeoutMs`, "must be > 0 when provided"));
    }
  }

  if (
    issues.length > 0 ||
    model === undefined ||
    promptTemplate === undefined
  ) {
    return { issues };
  }

  return {
    config: {
      model,
      promptTemplate,
      ...(systemPromptTemplate === undefined ? {} : { systemPromptTemplate }),
      ...(sessionStartPromptTemplate === undefined
        ? {}
        : { sessionStartPromptTemplate }),
      ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    issues,
  };
}

function rejectUnsupportedAddonEnv(
  addon: WorkflowNodeAddonRef,
  path: string,
): readonly ValidationIssue[] {
  if (addon.env === undefined) {
    return [];
  }
  return [
    makeIssue(
      `${path}.env`,
      `is not supported by ${addon.name} version ${addon.version ?? "1"}`,
    ),
  ];
}

function isAgentWorkerAddonName(
  name: string,
): name is
  | typeof CODEX_WORKER_ADDON_NAME
  | typeof CLAUDE_CODE_WORKER_ADDON_NAME {
  return (
    name === CODEX_WORKER_ADDON_NAME || name === CLAUDE_CODE_WORKER_ADDON_NAME
  );
}

function resolveAgentWorkerBackend(
  name: typeof CODEX_WORKER_ADDON_NAME | typeof CLAUDE_CODE_WORKER_ADDON_NAME,
): CliAgentBackend {
  switch (name) {
    case CODEX_WORKER_ADDON_NAME:
      return "codex-agent";
    case CLAUDE_CODE_WORKER_ADDON_NAME:
      return "claude-code-agent";
  }
}

export function resolveAgentWorkerPayload(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
}): {
  readonly payload?: NodePayload;
  readonly issues: readonly ValidationIssue[];
} {
  if (!isAgentWorkerAddonName(input.addon.name)) {
    return { issues: [] };
  }

  const version = input.addon.version ?? AGENT_WORKER_ADDON_VERSION;
  if (version !== AGENT_WORKER_ADDON_VERSION) {
    return {
      issues: [
        makeIssue(
          `${input.path}.version`,
          `unsupported version '${version}' for ${input.addon.name}`,
        ),
      ],
    };
  }
  if (input.addon.config !== undefined && !isRecord(input.addon.config)) {
    return {
      issues: [makeIssue(`${input.path}.config`, "must be an object")],
    };
  }
  if (input.addon.inputs !== undefined && !isRecord(input.addon.inputs)) {
    return {
      issues: [makeIssue(`${input.path}.inputs`, "must be an object")],
    };
  }
  const unsupportedEnvIssues = rejectUnsupportedAddonEnv(
    input.addon,
    input.path,
  );
  if (unsupportedEnvIssues.length > 0) {
    return { issues: unsupportedEnvIssues };
  }

  const normalized = normalizeAgentWorkerConfig(
    input.addon.config,
    `${input.path}.config`,
  );
  if (normalized.config === undefined) {
    return { issues: normalized.issues };
  }

  const addon: ResolvedNodeAddon = {
    name: input.addon.name,
    version: AGENT_WORKER_ADDON_VERSION,
    config: normalized.config,
    ...(input.addon.inputs === undefined ? {} : { inputs: input.addon.inputs }),
  };

  return {
    payload: {
      id: input.nodeId,
      description:
        input.addon.name === CODEX_WORKER_ADDON_NAME
          ? "Built-in worker that runs a Codex agent task."
          : "Built-in worker that runs a Claude Code agent task.",
      model: normalized.config.model,
      executionBackend: resolveAgentWorkerBackend(input.addon.name),
      promptTemplate: normalized.config.promptTemplate,
      ...(normalized.config.systemPromptTemplate === undefined
        ? {}
        : { systemPromptTemplate: normalized.config.systemPromptTemplate }),
      ...(normalized.config.sessionStartPromptTemplate === undefined
        ? {}
        : {
            sessionStartPromptTemplate:
              normalized.config.sessionStartPromptTemplate,
          }),
      ...(normalized.config.sessionPolicy === undefined
        ? {}
        : { sessionPolicy: normalized.config.sessionPolicy }),
      variables: input.addon.inputs ?? {},
      addon,
      ...(normalized.config.timeoutMs === undefined
        ? {}
        : { timeoutMs: normalized.config.timeoutMs }),
    },
    issues: [],
  };
}

function resolveGatewayPayload<Config>(
  input: {
    readonly nodeId: string;
    readonly addon: WorkflowNodeAddonRef;
    readonly path: string;
  },
  descriptor: BuiltinGatewayAddonDescriptor<Config>,
): {
  readonly payload?: NodePayload;
  readonly issues: readonly ValidationIssue[];
} {
  if (input.addon.name !== descriptor.name) {
    return { issues: [] };
  }

  const version = input.addon.version ?? descriptor.version;
  if (version !== descriptor.version) {
    return {
      issues: [
        makeIssue(
          `${input.path}.version`,
          `unsupported version '${version}' for ${descriptor.name}`,
        ),
      ],
    };
  }

  const fieldIssues = validateGatewayAddonFields(input.addon, input.path);
  if (fieldIssues.length > 0) {
    return { issues: fieldIssues };
  }

  const normalized = descriptor.normalizeConfig(
    input.addon.config,
    `${input.path}.config`,
  );
  if (normalized.config === undefined) {
    return { issues: normalized.issues };
  }

  return {
    payload: {
      id: input.nodeId,
      description: descriptor.description,
      nodeType: "addon",
      variables: input.addon.inputs ?? {},
      addon: descriptor.createResolvedAddon({
        config: normalized.config,
        authoredAddon: input.addon,
      }),
      output: descriptor.output,
    },
    issues: [],
  };
}

export function resolveXGatewayReadPayload(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
}): {
  readonly payload?: NodePayload;
  readonly issues: readonly ValidationIssue[];
} {
  return resolveGatewayPayload(input, X_GATEWAY_READ_DESCRIPTOR);
}

export function resolveXGatewayPayload(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
}): {
  readonly payload?: NodePayload;
  readonly issues: readonly ValidationIssue[];
} {
  return resolveGatewayPayload(input, X_GATEWAY_DESCRIPTOR);
}

export function resolveMailGatewayReadPayload(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
}): {
  readonly payload?: NodePayload;
  readonly issues: readonly ValidationIssue[];
} {
  return resolveGatewayPayload(input, MAIL_GATEWAY_READ_DESCRIPTOR);
}

export function resolveMailGatewayPayload(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
}): {
  readonly payload?: NodePayload;
  readonly issues: readonly ValidationIssue[];
} {
  return resolveGatewayPayload(input, MAIL_GATEWAY_DESCRIPTOR);
}

export function resolveSuperviserControlPayload(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
}): {
  readonly payload?: NodePayload;
  readonly issues: readonly ValidationIssue[];
} {
  if (!isSuperviserControlAddonName(input.addon.name)) {
    return { issues: [] };
  }
  const name: SuperviserControlAddonName = input.addon.name;
  const version = input.addon.version ?? SUPERVISER_CONTROL_ADDON_VERSION;
  if (version !== SUPERVISER_CONTROL_ADDON_VERSION) {
    return {
      issues: [
        makeIssue(
          `${input.path}.version`,
          `unsupported version '${version}' for ${name}`,
        ),
      ],
    };
  }
  let argumentsTemplate: Readonly<Record<string, unknown>> | undefined;
  let argumentBindings: NodePayload["argumentBindings"];
  const cfg = input.addon.config;
  if (cfg !== undefined) {
    if (!isRecord(cfg)) {
      return {
        issues: [makeIssue(`${input.path}.config`, "must be an object")],
      };
    }
    const allowed = new Set(["argumentsTemplate", "argumentBindings"]);
    for (const key of Object.keys(cfg)) {
      if (!allowed.has(key)) {
        return {
          issues: [
            makeIssue(
              `${input.path}.config.${key}`,
              "only argumentsTemplate and argumentBindings are allowed for divedra superviser control add-ons",
            ),
          ],
        };
      }
    }
    const at = cfg["argumentsTemplate"];
    if (at !== undefined) {
      if (!isRecord(at)) {
        return {
          issues: [
            makeIssue(
              `${input.path}.config.argumentsTemplate`,
              "must be an object",
            ),
          ],
        };
      }
      argumentsTemplate = at;
    }
    const ab = cfg["argumentBindings"];
    if (ab !== undefined) {
      if (!Array.isArray(ab)) {
        return {
          issues: [
            makeIssue(
              `${input.path}.config.argumentBindings`,
              "must be an array",
            ),
          ],
        };
      }
      argumentBindings = ab as NodePayload["argumentBindings"];
    }
  }
  if (input.addon.inputs !== undefined && !isRecord(input.addon.inputs)) {
    return {
      issues: [makeIssue(`${input.path}.inputs`, "must be an object")],
    };
  }
  const unsupportedEnvIssues = rejectUnsupportedAddonEnv(
    input.addon,
    input.path,
  );
  if (unsupportedEnvIssues.length > 0) {
    return { issues: unsupportedEnvIssues };
  }
  const addon: ResolvedSuperviserControlAddon = {
    name,
    version: SUPERVISER_CONTROL_ADDON_VERSION,
  };
  return {
    payload: {
      id: input.nodeId,
      description: describeSuperviserControlAddon(name),
      nodeType: "addon",
      variables: input.addon.inputs ?? {},
      addon,
      output: SUPERVISER_CONTROL_ADDON_OUTPUT,
      ...(argumentsTemplate === undefined ? {} : { argumentsTemplate }),
      ...(argumentBindings === undefined ? {} : { argumentBindings }),
    },
    issues: [],
  };
}

export function resolveBuiltinNodeAddonPayload(
  input: NodeAddonResolveInput,
): NodeAddonResolveResult {
  const version = input.addon.version ?? CHAT_REPLY_WORKER_ADDON_VERSION;
  const superviserControlPayload = resolveSuperviserControlPayload(input);
  if (
    superviserControlPayload.payload !== undefined ||
    superviserControlPayload.issues.length > 0
  ) {
    return superviserControlPayload;
  }
  const agentWorkerPayload = resolveAgentWorkerPayload(input);
  if (
    agentWorkerPayload.payload !== undefined ||
    agentWorkerPayload.issues.length > 0
  ) {
    return agentWorkerPayload;
  }
  const xGatewayReadPayload = resolveXGatewayReadPayload(input);
  if (
    xGatewayReadPayload.payload !== undefined ||
    xGatewayReadPayload.issues.length > 0
  ) {
    return xGatewayReadPayload;
  }
  const xGatewayPayload = resolveXGatewayPayload(input);
  if (
    xGatewayPayload.payload !== undefined ||
    xGatewayPayload.issues.length > 0
  ) {
    return xGatewayPayload;
  }
  const mailGatewayReadPayload = resolveMailGatewayReadPayload(input);
  if (
    mailGatewayReadPayload.payload !== undefined ||
    mailGatewayReadPayload.issues.length > 0
  ) {
    return mailGatewayReadPayload;
  }
  const mailGatewayPayload = resolveMailGatewayPayload(input);
  if (
    mailGatewayPayload.payload !== undefined ||
    mailGatewayPayload.issues.length > 0
  ) {
    return mailGatewayPayload;
  }

  if (input.addon.name !== CHAT_REPLY_WORKER_ADDON_NAME) {
    return {
      issues: [
        makeIssue(
          `${input.path}.name`,
          `unknown built-in node add-on '${input.addon.name}'`,
        ),
      ],
    };
  }
  if (version !== CHAT_REPLY_WORKER_ADDON_VERSION) {
    return {
      issues: [
        makeIssue(
          `${input.path}.version`,
          `unsupported version '${version}' for ${CHAT_REPLY_WORKER_ADDON_NAME}`,
        ),
      ],
    };
  }
  if (input.addon.config !== undefined && !isRecord(input.addon.config)) {
    return {
      issues: [makeIssue(`${input.path}.config`, "must be an object")],
    };
  }
  if (input.addon.inputs !== undefined && !isRecord(input.addon.inputs)) {
    return {
      issues: [makeIssue(`${input.path}.inputs`, "must be an object")],
    };
  }
  const unsupportedEnvIssues = rejectUnsupportedAddonEnv(
    input.addon,
    input.path,
  );
  if (unsupportedEnvIssues.length > 0) {
    return { issues: unsupportedEnvIssues };
  }

  const normalized = normalizeChatReplyWorkerConfig(
    input.addon.config,
    `${input.path}.config`,
  );
  if (normalized.config === undefined) {
    return { issues: normalized.issues };
  }

  const addon: ResolvedNodeAddon = {
    name: CHAT_REPLY_WORKER_ADDON_NAME,
    version: CHAT_REPLY_WORKER_ADDON_VERSION,
    config: normalized.config,
    ...(input.addon.inputs === undefined ? {} : { inputs: input.addon.inputs }),
  };

  return {
    payload: {
      id: input.nodeId,
      description:
        "Built-in worker that prepares a provider-neutral reply to the triggering chat event.",
      nodeType: "addon",
      variables: input.addon.inputs ?? {},
      addon,
      output: CHAT_REPLY_WORKER_OUTPUT,
    },
    issues: [],
  };
}
