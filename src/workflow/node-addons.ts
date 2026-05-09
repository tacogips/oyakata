import { resolveAddonSource } from "./catalog";
import { resolveLocalNodeAddonPayload } from "./local-node-addons";
import type {
  AsyncNodeAddonPayloadResolver,
  LoadOptions,
  NodeAddonDefinition,
  NodeAddonPayloadResolver,
  NodeAddonResolveResult,
  ResolvedWorkflowSource,
  WorkflowNodeAddonRef,
} from "./types";
import {
  definitionVersionMatches,
  describeAddonDefinitionVersions,
  errorMessageFromUnknown,
  isPromiseLike,
  makeIssue,
  normalizeThirdPartyResolverResult,
} from "./node-addons-constants";
import { resolveBuiltinNodeAddonPayload } from "./node-addons-builtin";

export {
  CHAT_REPLY_WORKER_ADDON_NAME,
  CHAT_REPLY_WORKER_ADDON_VERSION,
  CODEX_WORKER_ADDON_NAME,
  CLAUDE_CODE_WORKER_ADDON_NAME,
  AGENT_WORKER_ADDON_VERSION,
  X_GATEWAY_ADDON_NAME,
  X_GATEWAY_ADDON_VERSION,
  X_GATEWAY_READ_ADDON_NAME,
  X_GATEWAY_READ_ADDON_VERSION,
  DEFAULT_X_GATEWAY_IMAGE,
  MAIL_GATEWAY_ADDON_NAME,
  MAIL_GATEWAY_ADDON_VERSION,
  MAIL_GATEWAY_READ_ADDON_NAME,
  MAIL_GATEWAY_READ_ADDON_VERSION,
  DEFAULT_MAIL_GATEWAY_IMAGE,
  SUPERVISER_CONTROL_ADDON_VERSION,
} from "./node-addons-constants";

export { resolveBuiltinNodeAddonPayload } from "./node-addons-builtin";

export function createNodeAddonRegistry(
  definitions: readonly NodeAddonDefinition[],
): NodeAddonPayloadResolver {
  const registeredDefinitions = [...definitions];
  return (input) => {
    const matchingNameDefinitions = registeredDefinitions.filter(
      (definition) => definition.name === input.addon.name,
    );
    if (matchingNameDefinitions.length === 0) {
      return undefined;
    }

    const matchingDefinitions = matchingNameDefinitions.filter((definition) =>
      definitionVersionMatches(definition, input.addon),
    );
    if (matchingDefinitions.length === 0) {
      return {
        issues: [
          makeIssue(
            `${input.path}.version`,
            `unsupported version '${input.addon.version ?? "<unspecified>"}' for third-party node add-on '${input.addon.name}'; registered versions: ${describeAddonDefinitionVersions(matchingNameDefinitions)}`,
          ),
        ],
      };
    }

    if (input.addon.version === undefined && matchingDefinitions.length > 1) {
      return {
        issues: [
          makeIssue(
            `${input.path}.version`,
            `must be specified because multiple versions are registered for third-party node add-on '${input.addon.name}': ${describeAddonDefinitionVersions(matchingDefinitions)}`,
          ),
        ],
      };
    }

    const [definition] = matchingDefinitions;
    if (definition === undefined) {
      return undefined;
    }
    const resolved = definition.resolve(input);
    if (isPromiseLike(resolved)) {
      void Promise.resolve(resolved).catch(() => undefined);
      return {
        issues: [
          makeIssue(
            input.path,
            `third-party node add-on '${input.addon.name}' uses an async definition resolver; use loadWorkflowFromDisk or validateWorkflowBundleAsync for async add-ons`,
          ),
        ],
      };
    }
    return resolved;
  };
}

export function createNodeAddonPayloadResolver(
  definition: NodeAddonDefinition,
): NodeAddonPayloadResolver {
  return createNodeAddonRegistry([definition]);
}

export function createAsyncNodeAddonRegistry(
  definitions: readonly NodeAddonDefinition[],
): AsyncNodeAddonPayloadResolver {
  const registeredDefinitions = [...definitions];
  return async (input) => {
    const matchingNameDefinitions = registeredDefinitions.filter(
      (definition) => definition.name === input.addon.name,
    );
    if (matchingNameDefinitions.length === 0) {
      return undefined;
    }

    const matchingDefinitions = matchingNameDefinitions.filter((definition) =>
      definitionVersionMatches(definition, input.addon),
    );
    if (matchingDefinitions.length === 0) {
      return {
        issues: [
          makeIssue(
            `${input.path}.version`,
            `unsupported version '${input.addon.version ?? "<unspecified>"}' for third-party node add-on '${input.addon.name}'; registered versions: ${describeAddonDefinitionVersions(matchingNameDefinitions)}`,
          ),
        ],
      };
    }

    if (input.addon.version === undefined && matchingDefinitions.length > 1) {
      return {
        issues: [
          makeIssue(
            `${input.path}.version`,
            `must be specified because multiple versions are registered for third-party node add-on '${input.addon.name}': ${describeAddonDefinitionVersions(matchingDefinitions)}`,
          ),
        ],
      };
    }

    const [definition] = matchingDefinitions;
    return definition === undefined
      ? undefined
      : await definition.resolve(input);
  };
}

export function createAsyncNodeAddonPayloadResolver(
  definition: NodeAddonDefinition,
): AsyncNodeAddonPayloadResolver {
  return createAsyncNodeAddonRegistry([definition]);
}

function isBuiltinAddonNamespace(name: string): boolean {
  return name.startsWith("divedra/");
}

export function resolveNodeAddonPayload(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
  readonly workflowSource?: ResolvedWorkflowSource;
  readonly options?: LoadOptions;
  readonly thirdPartyResolvers?: readonly NodeAddonPayloadResolver[];
}): NodeAddonResolveResult {
  if (isBuiltinAddonNamespace(input.addon.name)) {
    return resolveBuiltinNodeAddonPayload(input);
  }

  for (const resolver of input.thirdPartyResolvers ?? []) {
    let resolvedRaw: unknown;
    try {
      resolvedRaw = resolver(input);
    } catch (error: unknown) {
      return {
        issues: [
          makeIssue(
            input.path,
            `third-party node add-on resolver failed for '${input.addon.name}': ${errorMessageFromUnknown(error)}`,
          ),
        ],
      };
    }

    const resolved = normalizeThirdPartyResolverResult({
      addonName: input.addon.name,
      path: input.path,
      value: resolvedRaw,
    });
    if (resolved.payload !== undefined || (resolved.issues ?? []).length > 0) {
      return resolved;
    }
  }

  if (requiresAsyncLocalAddonResolution(input)) {
    return {
      issues: [
        makeIssue(
          `${input.path}.name`,
          `local node add-on '${input.addon.name}' requires async workflow loading or validation`,
        ),
      ],
    };
  }

  return {
    issues: [
      makeIssue(
        `${input.path}.name`,
        `unknown third-party node add-on '${input.addon.name}'`,
      ),
    ],
  };
}

function requiresAsyncLocalAddonResolution(input: {
  readonly addon: WorkflowNodeAddonRef;
  readonly workflowSource?: ResolvedWorkflowSource;
  readonly options?: LoadOptions;
}): boolean {
  if (input.addon.version === undefined || input.addon.version.length === 0) {
    return false;
  }
  const env = input.options?.env ?? process.env;
  return (
    input.options?.addonRoot !== undefined ||
    (env["DIVEDRA_ADDON_ROOT"] ?? "").length > 0 ||
    (input.workflowSource !== undefined &&
      input.workflowSource.scope !== "direct")
  );
}

export async function resolveNodeAddonPayloadAsync(input: {
  readonly nodeId: string;
  readonly addon: WorkflowNodeAddonRef;
  readonly path: string;
  readonly workflowSource?: ResolvedWorkflowSource;
  readonly options?: LoadOptions;
  readonly thirdPartyResolvers?: readonly AsyncNodeAddonPayloadResolver[];
}): Promise<NodeAddonResolveResult> {
  if (isBuiltinAddonNamespace(input.addon.name)) {
    return resolveBuiltinNodeAddonPayload(input);
  }

  let deferredLocalIssue: import("./types").ValidationIssue | undefined;
  const localSource = await resolveAddonSource({
    addon: input.addon,
    ...(input.workflowSource === undefined
      ? {}
      : { workflowSource: input.workflowSource }),
    ...(input.options === undefined ? {} : { options: input.options }),
  });
  if (localSource.ok) {
    return await resolveLocalNodeAddonPayload({
      nodeId: input.nodeId,
      addon: input.addon,
      path: input.path,
      source: localSource.value,
    });
  }
  if (localSource.error.code !== "NOT_FOUND") {
    deferredLocalIssue = makeIssue(input.path, localSource.error.message);
    if ((input.thirdPartyResolvers ?? []).length === 0) {
      return { issues: [deferredLocalIssue] };
    }
  }

  for (const resolver of input.thirdPartyResolvers ?? []) {
    let resolvedRaw: unknown;
    try {
      resolvedRaw = await resolver(input);
    } catch (error: unknown) {
      return {
        issues: [
          makeIssue(
            input.path,
            `third-party node add-on resolver failed for '${input.addon.name}': ${errorMessageFromUnknown(error)}`,
          ),
        ],
      };
    }

    const resolved = normalizeThirdPartyResolverResult({
      addonName: input.addon.name,
      path: input.path,
      value: resolvedRaw,
    });
    if (resolved.payload !== undefined || (resolved.issues ?? []).length > 0) {
      return resolved;
    }
  }

  if (deferredLocalIssue !== undefined) {
    return { issues: [deferredLocalIssue] };
  }

  return {
    issues: [
      makeIssue(
        `${input.path}.name`,
        `unknown third-party node add-on '${input.addon.name}'`,
      ),
    ],
  };
}
