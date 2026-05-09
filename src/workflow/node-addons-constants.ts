import type {
  NodeOutputContract,
  NodePayload,
  ValidationIssue,
  WorkflowNodeAddonRef,
} from "./types";

export const CHAT_REPLY_WORKER_ADDON_NAME = "divedra/chat-reply-worker";
export const CHAT_REPLY_WORKER_ADDON_VERSION = "1";
export const CODEX_WORKER_ADDON_NAME = "divedra/codex-worker";
export const CLAUDE_CODE_WORKER_ADDON_NAME = "divedra/claude-code-worker";
export const AGENT_WORKER_ADDON_VERSION = "1";
export const X_GATEWAY_ADDON_NAME = "divedra/x-gateway";
export const X_GATEWAY_ADDON_VERSION = "1";
export const X_GATEWAY_READ_ADDON_NAME = "divedra/x-gateway-read";
export const X_GATEWAY_READ_ADDON_VERSION = "1";
export const DEFAULT_X_GATEWAY_IMAGE = "ghcr.io/tacogips/x-gateway:latest";
export const MAIL_GATEWAY_ADDON_NAME = "divedra/mail-gateway";
export const MAIL_GATEWAY_ADDON_VERSION = "1";
export const MAIL_GATEWAY_READ_ADDON_NAME = "divedra/mail-gateway-read";
export const MAIL_GATEWAY_READ_ADDON_VERSION = "1";
export const DEFAULT_MAIL_GATEWAY_IMAGE =
  "ghcr.io/tacogips/mail-gateway:latest";
export const SUPERVISER_CONTROL_ADDON_VERSION = "1";

export const CHAT_REPLY_WORKER_OUTPUT: NodeOutputContract = {
  description:
    "Provider-neutral chat reply request produced by the built-in chat reply worker.",
  jsonSchema: {
    type: "object",
    required: ["reply"],
    additionalProperties: true,
    properties: {
      reply: {
        type: "object",
        required: ["status", "target", "message", "idempotencyKey"],
        additionalProperties: true,
        properties: {
          status: {
            enum: ["sent", "queued", "intent-only", "dry-run"],
          },
          target: {
            type: "object",
            additionalProperties: true,
          },
          message: {
            type: "object",
            required: ["text"],
            additionalProperties: false,
            properties: {
              text: { type: "string", minLength: 1 },
            },
          },
          idempotencyKey: { type: "string", minLength: 1 },
          providerMessageId: { type: "string", minLength: 1 },
          dispatchId: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const X_GATEWAY_READ_OUTPUT: NodeOutputContract = {
  description:
    "Read-only x-gateway query result produced by the built-in x-gateway read add-on.",
  jsonSchema: {
    type: "object",
    required: ["xGateway"],
    additionalProperties: true,
    properties: {
      xGateway: {
        type: "object",
        required: ["ok"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          data: {},
        },
      },
    },
  },
};

export const X_GATEWAY_OUTPUT: NodeOutputContract = {
  description:
    "x-gateway query or mutation result produced by the built-in x-gateway add-on.",
  jsonSchema: {
    type: "object",
    required: ["xGateway"],
    additionalProperties: true,
    properties: {
      xGateway: {
        type: "object",
        required: ["ok"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          data: {},
        },
      },
    },
  },
};

export const MAIL_GATEWAY_READ_OUTPUT: NodeOutputContract = {
  description:
    "Read-only mail-gateway query result produced by the built-in mail-gateway read add-on.",
  jsonSchema: {
    type: "object",
    required: ["mailGateway"],
    additionalProperties: true,
    properties: {
      mailGateway: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
};

export const MAIL_GATEWAY_OUTPUT: NodeOutputContract = {
  description:
    "mail-gateway query or mutation result produced by the built-in mail-gateway add-on.",
  jsonSchema: {
    type: "object",
    required: ["mailGateway"],
    additionalProperties: true,
    properties: {
      mailGateway: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
};

export const SUPERVISER_CONTROL_ADDON_OUTPUT: NodeOutputContract = {
  description:
    "Nested superviser control-plane result (start/status/rerun/load/save) scoped to a supervision run (phase-2 auto-improve).",
  jsonSchema: {
    type: "object",
    required: ["superviser"],
    additionalProperties: true,
    properties: {
      superviser: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
};

export function makeIssue(path: string, message: string): ValidationIssue {
  return { severity: "error", path, message };
}

export function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidationIssue(value: unknown): value is ValidationIssue {
  if (!isRecord(value)) {
    return false;
  }
  const severity = value["severity"];
  return (
    (severity === "error" || severity === "warning") &&
    typeof value["path"] === "string" &&
    typeof value["message"] === "string"
  );
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

export function normalizeThirdPartyResolverResult(input: {
  readonly addonName: string;
  readonly path: string;
  readonly value: unknown;
}): {
  readonly issues: readonly ValidationIssue[];
  readonly payload?: NodePayload;
} {
  if (input.value === undefined) {
    return { issues: [] };
  }
  if (!isRecord(input.value)) {
    return {
      issues: [
        makeIssue(
          `${input.path}.resolverResult`,
          `third-party node add-on resolver for '${input.addonName}' must return an object result`,
        ),
      ],
    };
  }

  const issuesRaw = input.value["issues"] ?? [];
  if (!Array.isArray(issuesRaw)) {
    return {
      issues: [
        makeIssue(
          `${input.path}.resolverResult.issues`,
          `third-party node add-on resolver for '${input.addonName}' must return issues as an array`,
        ),
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  for (const [index, issue] of issuesRaw.entries()) {
    if (isValidationIssue(issue)) {
      issues.push(issue);
      continue;
    }
    return {
      issues: [
        makeIssue(
          `${input.path}.resolverResult.issues[${index}]`,
          "must contain validation issues with severity, path, and message",
        ),
      ],
    };
  }

  const payload = input.value["payload"];
  return {
    issues,
    ...(payload === undefined ? {} : { payload: payload as NodePayload }),
  };
}

export function definitionVersionMatches(
  definition: { readonly version?: string },
  addon: WorkflowNodeAddonRef,
): boolean {
  return (
    definition.version === undefined ||
    addon.version === undefined ||
    definition.version === addon.version
  );
}

export function describeAddonDefinitionVersions(
  definitions: readonly { readonly version?: string }[],
): string {
  return definitions
    .map((definition) => definition.version ?? "<unspecified>")
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
}

export function readOptionalStringConfig(
  config: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  issues.push(makeIssue(`${path}.${key}`, "must be a non-empty string"));
  return undefined;
}

export function readRequiredStringConfig(
  config: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  const value = readOptionalStringConfig(config, key, path, issues);
  if (value === undefined && config[key] === undefined) {
    issues.push(makeIssue(`${path}.${key}`, "must be a non-empty string"));
  }
  return value;
}

export function normalizeSessionPolicy(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): { readonly mode: "new" | "reuse" } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue(path, "must be an object when provided"));
    return undefined;
  }
  const mode = value["mode"];
  if (mode !== "new" && mode !== "reuse") {
    issues.push(makeIssue(`${path}.mode`, "must be 'new' or 'reuse'"));
    return undefined;
  }
  return { mode };
}
