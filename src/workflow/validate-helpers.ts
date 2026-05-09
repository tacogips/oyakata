import {
  isReservedWorkflowDefinitionPath,
  isSafeWorkflowRelativePath,
} from "./prompt-template-file";
import { normalizeWorkingDirectoryPath } from "./working-directory";
import {
  DEFAULT_CONTAINER_RUNNER_KIND,
  type ContainerBuild,
  type ContainerExecution,
  type ContainerRuntimeDefaults,
  type ContainerRunnerKind,
  type CommandExecution,
  type LoadOptions,
  type NodeDurability,
  type NodeExecutionBackend,
  type NodeRole,
  type NodeSessionPolicy,
  type NodeType,
  type ValidationIssue,
  type WorkflowNodeAddonEnvBinding,
  type WorkflowNodeAddonRef,
} from "./types";

export type UnknownRecord = Record<string, unknown>;

export interface WorkflowValidationOptions
  extends Pick<
    LoadOptions,
    | "workflowRoot"
    | "workflowScope"
    | "userRoot"
    | "projectRoot"
    | "addonRoot"
    | "resolvedWorkflowSource"
    | "env"
    | "cwd"
    | "nodeAddons"
    | "asyncNodeAddonResolvers"
    | "nodeAddonResolvers"
  > {
  readonly allowResolvedStepFileFields?: boolean;
}

export function isStrictWorkflowAuthorshipValidation(
  _options: WorkflowValidationOptions,
): boolean {
  return true;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiresSeparatedModel(
  executionBackend: NodeExecutionBackend | undefined,
): executionBackend is NodeExecutionBackend {
  return executionBackend !== undefined;
}

export function isLegacyCliModelIdentifier(value: unknown): value is string {
  return (
    value === "tacogips/codex-agent" || value === "tacogips/claude-code-agent"
  );
}

export function isNodeSessionMode(
  value: unknown,
): value is NodeSessionPolicy["mode"] {
  return value === "new" || value === "reuse";
}

export function isNodeType(value: unknown): value is NodeType {
  return (
    value === "agent" ||
    value === "command" ||
    value === "container" ||
    value === "user-action"
  );
}

export function isContainerRunnerKind(
  value: unknown,
): value is ContainerRunnerKind {
  return (
    value === "podman" ||
    value === "docker" ||
    value === "nerdctl" ||
    value === "apple-container"
  );
}

export function makeIssue(
  severity: "error" | "warning",
  path: string,
  message: string,
): ValidationIssue {
  return { severity, path, message };
}

export function normalizeWorkingDirectoryField(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    try {
      return normalizeWorkingDirectoryPath(value);
    } catch {
      // Validation reports the normalized issue below.
    }
  }
  issues.push(
    makeIssue(
      "error",
      path,
      "must be a non-empty absolute or relative path when provided",
    ),
  );
  return undefined;
}

export function normalizeNodeRole(value: unknown): NodeRole | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "manager" || value === "worker") {
    return value;
  }
  return undefined;
}

export function readStringField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(
      makeIssue("error", `${path}.${key}`, "must be a non-empty string"),
    );
    return null;
  }
  return value;
}

export function readNumberField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(
      makeIssue("error", `${path}.${key}`, "must be a finite number"),
    );
    return null;
  }
  return value;
}

export function isAbsoluteContainerPath(value: string): boolean {
  return value.startsWith("/");
}

export function normalizeStringArrayField(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    issues.push(makeIssue("error", path, "must be an array when provided"));
    return undefined;
  }
  const entries: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push(
        makeIssue("error", `${path}[${index}]`, "must be a non-empty string"),
      );
      return;
    }
    entries.push(entry);
  });
  return entries;
}

export function normalizeStringMapField(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }
  const entries: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      issues.push(
        makeIssue("error", `${path}.${key}`, "must be a string when provided"),
      );
      continue;
    }
    entries[key] = entryValue;
  }
  return entries;
}

export function normalizeContainerBuild(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ContainerBuild | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const allowedKeys = new Set(["contextPath", "containerfilePath", "target"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported container build field",
        ),
      );
    }
  }

  const contextPath = readStringField(value, "contextPath", path, issues);
  if (contextPath !== null && !isSafeWorkflowRelativePath(contextPath)) {
    issues.push(
      makeIssue(
        "error",
        `${path}.contextPath`,
        "must be a workflow-relative path without '.' or '..' segments",
      ),
    );
  }

  const containerfilePathRaw = value["containerfilePath"];
  let containerfilePath: string | undefined;
  if (containerfilePathRaw !== undefined) {
    if (
      typeof containerfilePathRaw !== "string" ||
      containerfilePathRaw.length === 0
    ) {
      issues.push(
        makeIssue(
          "error",
          `${path}.containerfilePath`,
          "must be a non-empty string when provided",
        ),
      );
    } else if (!isSafeWorkflowRelativePath(containerfilePathRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.containerfilePath`,
          "must be a workflow-relative path without '.' or '..' segments",
        ),
      );
    } else if (isReservedWorkflowDefinitionPath(containerfilePathRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.containerfilePath`,
          "must not target canonical workflow definition files such as workflow.json or node-*.json",
        ),
      );
    } else {
      containerfilePath = containerfilePathRaw;
    }
  }

  if (value["dockerfilePath"] !== undefined) {
    issues.push(
      makeIssue(
        "error",
        `${path}.dockerfilePath`,
        "legacy field 'dockerfilePath' is not supported; use 'containerfilePath'",
      ),
    );
  }
  const targetRaw = value["target"];
  let target: string | undefined;
  if (targetRaw !== undefined) {
    if (typeof targetRaw === "string" && targetRaw.length > 0) {
      target = targetRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.target`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  if (contextPath === null || !isSafeWorkflowRelativePath(contextPath)) {
    return undefined;
  }

  return {
    contextPath,
    ...(containerfilePath === undefined ? {} : { containerfilePath }),
    ...(target === undefined ? {} : { target }),
  };
}

export function normalizeContainerRuntimeDefaults(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ContainerRuntimeDefaults {
  if (value === undefined) {
    return { runnerKind: DEFAULT_CONTAINER_RUNNER_KIND };
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return { runnerKind: DEFAULT_CONTAINER_RUNNER_KIND };
  }

  const allowedKeys = new Set(["runnerKind", "runnerPath"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported container runtime defaults field",
        ),
      );
    }
  }

  const runnerKindRaw = value["runnerKind"];
  let runnerKind = DEFAULT_CONTAINER_RUNNER_KIND;
  if (runnerKindRaw !== undefined) {
    if (isContainerRunnerKind(runnerKindRaw)) {
      runnerKind = runnerKindRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.runnerKind`,
          "must be podman, docker, nerdctl, or apple-container",
        ),
      );
    }
  }

  const runnerPathRaw = value["runnerPath"];
  let runnerPath: string | undefined;
  if (runnerPathRaw !== undefined) {
    if (typeof runnerPathRaw === "string" && runnerPathRaw.length > 0) {
      runnerPath = runnerPathRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.runnerPath`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  return {
    runnerKind,
    ...(runnerPath === undefined ? {} : { runnerPath }),
  };
}

export function normalizeCommandExecution(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): CommandExecution | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const allowedKeys = new Set([
    "scriptPath",
    "argvTemplate",
    "envTemplate",
    "workingDirectory",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported command field",
        ),
      );
    }
  }

  const scriptPath = readStringField(value, "scriptPath", path, issues);
  if (scriptPath !== null && !isSafeWorkflowRelativePath(scriptPath)) {
    issues.push(
      makeIssue(
        "error",
        `${path}.scriptPath`,
        "must be a workflow-relative path without '.' or '..' segments",
      ),
    );
  }

  const argvTemplate = normalizeStringArrayField(
    value["argvTemplate"],
    `${path}.argvTemplate`,
    issues,
  );
  const envTemplate = normalizeStringMapField(
    value["envTemplate"],
    `${path}.envTemplate`,
    issues,
  );

  const workingDirectoryRaw = value["workingDirectory"];
  const workingDirectory = normalizeWorkingDirectoryField(
    workingDirectoryRaw,
    `${path}.workingDirectory`,
    issues,
  );

  if (scriptPath === null || !isSafeWorkflowRelativePath(scriptPath)) {
    return undefined;
  }

  return {
    scriptPath,
    ...(argvTemplate === undefined ? {} : { argvTemplate }),
    ...(envTemplate === undefined ? {} : { envTemplate }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}

export function normalizeContainerExecution(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ContainerExecution | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const allowedKeys = new Set([
    "runnerKind",
    "runnerPath",
    "image",
    "build",
    "entrypoint",
    "argsTemplate",
    "envTemplate",
    "workingDirectory",
    "workspace",
    "resources",
    "networkPolicy",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${key}`,
          "uses an unsupported container field",
        ),
      );
    }
  }

  const runnerKindRaw = value["runnerKind"];
  let runnerKind: ContainerRunnerKind | undefined;
  if (runnerKindRaw !== undefined) {
    if (isContainerRunnerKind(runnerKindRaw)) {
      runnerKind = runnerKindRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.runnerKind`,
          "must be podman, docker, nerdctl, or apple-container",
        ),
      );
    }
  }

  const runnerPathRaw = value["runnerPath"];
  let runnerPath: string | undefined;
  if (runnerPathRaw !== undefined) {
    if (typeof runnerPathRaw === "string" && runnerPathRaw.length > 0) {
      runnerPath = runnerPathRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.runnerPath`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const imageRaw = value["image"];
  let image: string | undefined;
  if (imageRaw !== undefined) {
    if (typeof imageRaw === "string" && imageRaw.length > 0) {
      image = imageRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.image`,
          "must be a non-empty string when provided",
        ),
      );
    }
  }

  const build = normalizeContainerBuild(
    value["build"],
    `${path}.build`,
    issues,
  );
  if ((image === undefined) === (build === undefined)) {
    issues.push(
      makeIssue(
        "error",
        path,
        "must declare exactly one of container.image or container.build",
      ),
    );
  }

  const entrypoint = normalizeStringArrayField(
    value["entrypoint"],
    `${path}.entrypoint`,
    issues,
  );
  const argsTemplate = normalizeStringArrayField(
    value["argsTemplate"],
    `${path}.argsTemplate`,
    issues,
  );
  const envTemplate = normalizeStringMapField(
    value["envTemplate"],
    `${path}.envTemplate`,
    issues,
  );

  const workingDirectoryRaw = value["workingDirectory"];
  let workingDirectory: string | undefined;
  if (workingDirectoryRaw !== undefined) {
    if (
      typeof workingDirectoryRaw === "string" &&
      workingDirectoryRaw.length > 0 &&
      isAbsoluteContainerPath(workingDirectoryRaw)
    ) {
      workingDirectory = workingDirectoryRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.workingDirectory`,
          "must be an absolute container path when provided",
        ),
      );
    }
  }

  const workspaceRaw = value["workspace"];
  let workspace: ContainerExecution["workspace"];
  if (workspaceRaw !== undefined) {
    if (!isRecord(workspaceRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.workspace`,
          "must be an object when provided",
        ),
      );
    } else {
      const modeRaw = workspaceRaw["mode"];
      let mode: "none" | "ephemeral" | undefined;
      if (modeRaw !== undefined) {
        if (modeRaw === "none" || modeRaw === "ephemeral") {
          mode = modeRaw;
        } else {
          issues.push(
            makeIssue(
              "error",
              `${path}.workspace.mode`,
              "must be 'none' or 'ephemeral'",
            ),
          );
        }
      }
      const mountPathRaw = workspaceRaw["mountPath"];
      let mountPath: string | undefined;
      if (mountPathRaw !== undefined) {
        if (
          typeof mountPathRaw === "string" &&
          mountPathRaw.length > 0 &&
          isAbsoluteContainerPath(mountPathRaw)
        ) {
          mountPath = mountPathRaw;
        } else {
          issues.push(
            makeIssue(
              "error",
              `${path}.workspace.mountPath`,
              "must be an absolute container path when provided",
            ),
          );
        }
      }
      workspace = {
        ...(mode === undefined ? {} : { mode }),
        ...(mountPath === undefined ? {} : { mountPath }),
      };
    }
  }

  const resourcesRaw = value["resources"];
  let resources: ContainerExecution["resources"];
  if (resourcesRaw !== undefined) {
    if (!isRecord(resourcesRaw)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.resources`,
          "must be an object when provided",
        ),
      );
    } else {
      const parsed: Record<string, number> = {};
      for (const key of ["cpuMax", "memoryMaxMb", "pidsMax"] as const) {
        const rawValue = resourcesRaw[key];
        if (rawValue === undefined) {
          continue;
        }
        if (
          typeof rawValue === "number" &&
          Number.isFinite(rawValue) &&
          rawValue > 0
        ) {
          parsed[key] = rawValue;
        } else {
          issues.push(
            makeIssue(
              "error",
              `${path}.resources.${key}`,
              "must be > 0 when provided",
            ),
          );
        }
      }
      resources = parsed;
    }
  }

  const networkPolicyRaw = value["networkPolicy"];
  let networkPolicy: "disabled" | "egress-allowed" | undefined;
  if (networkPolicyRaw !== undefined) {
    if (
      networkPolicyRaw === "disabled" ||
      networkPolicyRaw === "egress-allowed"
    ) {
      networkPolicy = networkPolicyRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.networkPolicy`,
          "must be 'disabled' or 'egress-allowed'",
        ),
      );
    }
  }

  return {
    ...(runnerKind === undefined ? {} : { runnerKind }),
    ...(runnerPath === undefined ? {} : { runnerPath }),
    ...(image === undefined ? {} : { image }),
    ...(build === undefined ? {} : { build }),
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(argsTemplate === undefined ? {} : { argsTemplate }),
    ...(envTemplate === undefined ? {} : { envTemplate }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(resources === undefined ? {} : { resources }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
  };
}

export function normalizeNodeDurability(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): NodeDurability | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const modeRaw = value["mode"];
  if (modeRaw !== "disabled" && modeRaw !== "node-persistent") {
    issues.push(
      makeIssue(
        "error",
        `${path}.mode`,
        "must be 'disabled' or 'node-persistent'",
      ),
    );
    return undefined;
  }

  const mountPathRaw = value["mountPath"];
  let mountPath: string | undefined;
  if (mountPathRaw !== undefined) {
    if (
      typeof mountPathRaw === "string" &&
      mountPathRaw.length > 0 &&
      isAbsoluteContainerPath(mountPathRaw)
    ) {
      mountPath = mountPathRaw;
    } else {
      issues.push(
        makeIssue(
          "error",
          `${path}.mountPath`,
          "must be an absolute container path when provided",
        ),
      );
    }
  }

  return {
    mode: modeRaw,
    ...(mountPath === undefined ? {} : { mountPath }),
  };
}

export const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvVarName(value: string): boolean {
  return ENV_VAR_NAME_PATTERN.test(value);
}

export function normalizeWorkflowNodeAddonEnvBinding(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WorkflowNodeAddonEnvBinding | undefined {
  if (typeof value === "string") {
    if (value.length === 0 || !isValidEnvVarName(value)) {
      issues.push(
        makeIssue("error", path, "must be a valid environment variable name"),
      );
      return undefined;
    }
    return { fromEnv: value };
  }

  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be a string or object"));
    return undefined;
  }

  const allowedKeys = new Set(["fromEnv", "required"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(makeIssue("error", `${path}.${key}`, "is not supported"));
    }
  }

  const fromEnv = value["fromEnv"];
  if (typeof fromEnv !== "string" || !isValidEnvVarName(fromEnv)) {
    issues.push(
      makeIssue(
        "error",
        `${path}.fromEnv`,
        "must be a valid environment variable name",
      ),
    );
    return undefined;
  }

  const required = value["required"];
  if (required !== undefined && typeof required !== "boolean") {
    issues.push(makeIssue("error", `${path}.required`, "must be a boolean"));
  }

  return {
    fromEnv,
    ...(typeof required === "boolean" ? { required } : {}),
  };
}

export function normalizeWorkflowNodeAddonEnv(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): Readonly<Record<string, WorkflowNodeAddonEnvBinding>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be an object when provided"));
    return undefined;
  }

  const bindings: Record<string, WorkflowNodeAddonEnvBinding> = {};
  for (const [targetEnv, bindingValue] of Object.entries(value)) {
    if (!isValidEnvVarName(targetEnv)) {
      issues.push(
        makeIssue(
          "error",
          `${path}.${targetEnv}`,
          "target must be a valid environment variable name",
        ),
      );
      continue;
    }
    const binding = normalizeWorkflowNodeAddonEnvBinding(
      bindingValue,
      `${path}.${targetEnv}`,
      issues,
    );
    if (binding !== undefined) {
      bindings[targetEnv] = binding;
    }
  }
  return bindings;
}

export function normalizeWorkflowNodeAddonRef(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): WorkflowNodeAddonRef | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      issues.push(makeIssue("error", path, "must be a non-empty string"));
      return undefined;
    }
    return { name: value };
  }

  if (!isRecord(value)) {
    issues.push(makeIssue("error", path, "must be a string or object"));
    return undefined;
  }

  const allowedKeys = new Set(["name", "version", "config", "env", "inputs"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(makeIssue("error", `${path}.${key}`, "is not supported"));
    }
  }

  const name = readStringField(value, "name", path, issues);
  const versionRaw = value["version"];
  let version: string | undefined;
  if (versionRaw !== undefined) {
    if (typeof versionRaw === "string" && versionRaw.length > 0) {
      version = versionRaw;
    } else {
      issues.push(
        makeIssue("error", `${path}.version`, "must be a non-empty string"),
      );
    }
  }

  const configRaw = value["config"];
  if (configRaw !== undefined && !isRecord(configRaw)) {
    issues.push(makeIssue("error", `${path}.config`, "must be an object"));
  }
  const env = normalizeWorkflowNodeAddonEnv(
    value["env"],
    `${path}.env`,
    issues,
  );
  const inputsRaw = value["inputs"];
  if (inputsRaw !== undefined && !isRecord(inputsRaw)) {
    issues.push(makeIssue("error", `${path}.inputs`, "must be an object"));
  }

  if (name === null) {
    return undefined;
  }

  return {
    name,
    ...(version === undefined ? {} : { version }),
    ...(isRecord(configRaw) ? { config: configRaw } : {}),
    ...(env === undefined ? {} : { env }),
    ...(isRecord(inputsRaw) ? { inputs: inputsRaw } : {}),
  };
}

export function normalizeNamedStringArrayField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): readonly string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.push(makeIssue("error", `${path}.${key}`, "must be an array"));
    return null;
  }
  const normalized = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (normalized.length !== value.length) {
    issues.push(
      makeIssue(
        "error",
        `${path}.${key}`,
        "must contain only non-empty strings",
      ),
    );
  }
  return normalized;
}

export function normalizeOptionalNamedStringArrayField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeNamedStringArrayField(record, key, path, issues);
  return normalized === null ? undefined : normalized;
}

export function normalizeOptionalBooleanField(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    issues.push(
      makeIssue("error", `${path}.${key}`, "must be a boolean when provided"),
    );
    return undefined;
  }
  return value;
}
