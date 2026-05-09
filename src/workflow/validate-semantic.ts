import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isSafeWorkflowName } from "./paths";
import {
  DEFAULT_MAX_LOOP_ITERATIONS,
  DEFAULT_NODE_TIMEOUT_MS,
  getNormalizedNodePayload,
  getStructuralEdges,
  getStructuralLoops,
  type NormalizedWorkflowBundle,
  type ValidationIssue,
} from "./types";
import {
  isRecord,
  makeIssue,
  type WorkflowValidationOptions,
} from "./validate-helpers";

export function intervalsPartiallyOverlap(
  left: Readonly<{ startOrder: number; endOrder: number }>,
  right: Readonly<{ startOrder: number; endOrder: number }>,
): boolean {
  const leftStartsInsideRight =
    right.startOrder < left.startOrder &&
    left.startOrder <= right.endOrder &&
    right.endOrder < left.endOrder;
  const rightStartsInsideLeft =
    left.startOrder < right.startOrder &&
    right.startOrder <= left.endOrder &&
    left.endOrder < right.endOrder;
  return leftStartsInsideRight || rightStartsInsideLeft;
}

export function findNodeIdByOrder(
  bundle: NormalizedWorkflowBundle,
  order: number,
): string {
  return bundle.workflow.nodes[order]?.id ?? "unknown";
}

export function pushCrossingIntervalIssue(
  issues: ValidationIssue[],
  bundle: NormalizedWorkflowBundle,
  args: {
    readonly path: string;
    readonly leftId: string;
    readonly leftStartOrder: number;
    readonly rightId: string;
    readonly rightStartOrder: number;
    readonly messagePrefix: string;
  },
): void {
  const earlierId =
    args.leftStartOrder <= args.rightStartOrder ? args.leftId : args.rightId;
  const laterId = earlierId === args.leftId ? args.rightId : args.leftId;
  const crossingNodeId = findNodeIdByOrder(
    bundle,
    args.leftStartOrder <= args.rightStartOrder
      ? args.rightStartOrder
      : args.leftStartOrder,
  );
  issues.push(
    makeIssue(
      "error",
      args.path,
      `${args.messagePrefix} '${earlierId}' and '${laterId}' cross; reorder or nest them cleanly around node '${crossingNodeId}'`,
    ),
  );
}

export function resolveCalleeStepFilePath(
  workflowDirectory: string,
  relativeStepFile: string,
): string | undefined {
  if (
    relativeStepFile.length === 0 ||
    path.posix.isAbsolute(relativeStepFile) ||
    path.win32.isAbsolute(relativeStepFile)
  ) {
    return undefined;
  }
  const segments = relativeStepFile
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  const resolved = path.resolve(workflowDirectory, relativeStepFile);
  const relative = path.relative(workflowDirectory, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? undefined
    : resolved;
}

export function inferSingleManagerStepIdFromRawSync(input: {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly workflowDirectory: string;
}): { ok: true; managerStepId?: string } | { ok: false; message: string } {
  const stepsRaw = input.raw["steps"];
  if (!Array.isArray(stepsRaw)) {
    return { ok: true };
  }

  const managerIds = new Set<string>();
  for (const step of stepsRaw) {
    if (!isRecord(step)) {
      continue;
    }
    const authoredId =
      typeof step["id"] === "string" && step["id"].length > 0
        ? step["id"]
        : undefined;
    if (step["role"] === "manager" && authoredId !== undefined) {
      managerIds.add(authoredId);
      continue;
    }

    const stepFile = step["stepFile"];
    if (typeof stepFile !== "string" || stepFile.length === 0) {
      continue;
    }
    const resolvedStepFile = resolveCalleeStepFilePath(
      input.workflowDirectory,
      stepFile,
    );
    if (resolvedStepFile === undefined) {
      return {
        ok: false,
        message: `callee stepFile '${stepFile}' must stay within workflow directory '${input.workflowDirectory}'`,
      };
    }
    let rawStep: unknown;
    try {
      rawStep = JSON.parse(readFileSync(resolvedStepFile, "utf8")) as unknown;
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? `failed to read callee stepFile '${stepFile}': ${error.message}`
            : `failed to read callee stepFile '${stepFile}'`,
      };
    }
    if (!isRecord(rawStep)) {
      return {
        ok: false,
        message: `callee stepFile '${stepFile}' must contain a JSON object`,
      };
    }
    if (rawStep["role"] !== "manager") {
      continue;
    }
    const resolvedId =
      authoredId ??
      (typeof rawStep["id"] === "string" && rawStep["id"].length > 0
        ? rawStep["id"]
        : undefined);
    if (resolvedId !== undefined) {
      managerIds.add(resolvedId);
    }
  }

  const explicitManagerStepId = input.raw["managerStepId"];
  if (
    managerIds.size > 1 &&
    !(
      typeof explicitManagerStepId === "string" &&
      explicitManagerStepId.length > 0
    )
  ) {
    return {
      ok: false,
      message:
        "callee workflow declares more than one manager-role step; set managerStepId explicitly or fix the callee workflow authorship",
    };
  }
  const managerStepId = [...managerIds][0];
  return managerStepId === undefined
    ? { ok: true }
    : { ok: true, managerStepId };
}

export async function inferSingleManagerStepIdFromRawAsync(input: {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly workflowDirectory: string;
}): Promise<
  { ok: true; managerStepId?: string } | { ok: false; message: string }
> {
  const stepsRaw = input.raw["steps"];
  if (!Array.isArray(stepsRaw)) {
    return { ok: true };
  }

  const managerIds = new Set<string>();
  for (const step of stepsRaw) {
    if (!isRecord(step)) {
      continue;
    }
    const authoredId =
      typeof step["id"] === "string" && step["id"].length > 0
        ? step["id"]
        : undefined;
    if (step["role"] === "manager" && authoredId !== undefined) {
      managerIds.add(authoredId);
      continue;
    }

    const stepFile = step["stepFile"];
    if (typeof stepFile !== "string" || stepFile.length === 0) {
      continue;
    }
    const resolvedStepFile = resolveCalleeStepFilePath(
      input.workflowDirectory,
      stepFile,
    );
    if (resolvedStepFile === undefined) {
      return {
        ok: false,
        message: `callee stepFile '${stepFile}' must stay within workflow directory '${input.workflowDirectory}'`,
      };
    }
    let rawStep: unknown;
    try {
      rawStep = JSON.parse(await readFile(resolvedStepFile, "utf8")) as unknown;
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? `failed to read callee stepFile '${stepFile}': ${error.message}`
            : `failed to read callee stepFile '${stepFile}'`,
      };
    }
    if (!isRecord(rawStep)) {
      return {
        ok: false,
        message: `callee stepFile '${stepFile}' must contain a JSON object`,
      };
    }
    if (rawStep["role"] !== "manager") {
      continue;
    }
    const resolvedId =
      authoredId ??
      (typeof rawStep["id"] === "string" && rawStep["id"].length > 0
        ? rawStep["id"]
        : undefined);
    if (resolvedId !== undefined) {
      managerIds.add(resolvedId);
    }
  }

  const explicitManagerStepId = input.raw["managerStepId"];
  if (
    managerIds.size > 1 &&
    !(
      typeof explicitManagerStepId === "string" &&
      explicitManagerStepId.length > 0
    )
  ) {
    return {
      ok: false,
      message:
        "callee workflow declares more than one manager-role step; set managerStepId explicitly or fix the callee workflow authorship",
    };
  }
  const managerStepId = [...managerIds][0];
  return managerStepId === undefined
    ? { ok: true }
    : { ok: true, managerStepId };
}

export function parseCalleeWorkflowJsonText(
  text: string,
):
  | { ok: true; raw: Readonly<Record<string, unknown>> }
  | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "callee workflow.json is not valid JSON" };
  }
  if (!isRecord(raw)) {
    return { ok: false, message: "callee workflow.json must be a JSON object" };
  }
  return { ok: true, raw };
}

export function resolveCalleeWorkflowJsonByIdSync(input: {
  readonly workflowRoot: string;
  readonly workflowId: string;
}):
  | {
      ok: true;
      raw: Readonly<Record<string, unknown>>;
      workflowDirectory: string;
    }
  | { ok: false; message: string } {
  let directoryEntries: ReturnType<typeof readdirSync>;
  try {
    directoryEntries = readdirSync(input.workflowRoot, {
      withFileTypes: true,
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `failed listing workflow root '${input.workflowRoot}': ${error.message}`
          : `failed listing workflow root '${input.workflowRoot}'`,
    };
  }

  const candidateDirectories = directoryEntries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => {
      if (left.name === input.workflowId) {
        return -1;
      }
      if (right.name === input.workflowId) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });

  let preferredDirectoryError: string | undefined;
  for (const entry of candidateDirectories) {
    const workflowDirectory = path.join(input.workflowRoot, entry.name);
    const workflowJsonPath = path.join(workflowDirectory, "workflow.json");
    let text: string;
    try {
      text = readFileSync(workflowJsonPath, "utf8");
    } catch (error) {
      if (entry.name === input.workflowId) {
        preferredDirectoryError =
          error instanceof Error
            ? error.message
            : "failed to read callee workflow.json";
      }
      continue;
    }
    const parsed = parseCalleeWorkflowJsonText(text);
    if (!parsed.ok) {
      if (entry.name === input.workflowId) {
        preferredDirectoryError = parsed.message;
      }
      continue;
    }
    if (parsed.raw["workflowId"] !== input.workflowId) {
      continue;
    }
    return {
      ok: true,
      raw: parsed.raw,
      workflowDirectory,
    };
  }

  if (preferredDirectoryError !== undefined) {
    return { ok: false, message: preferredDirectoryError };
  }
  return {
    ok: false,
    message: `workflow id '${input.workflowId}' was not found under workflow root '${input.workflowRoot}'`,
  };
}

export async function resolveCalleeWorkflowJsonByIdAsync(input: {
  readonly workflowRoot: string;
  readonly workflowId: string;
}): Promise<
  | {
      ok: true;
      raw: Readonly<Record<string, unknown>>;
      workflowDirectory: string;
    }
  | { ok: false; message: string }
> {
  let directoryEntries: Awaited<ReturnType<typeof readdir>>;
  try {
    directoryEntries = await readdir(input.workflowRoot, {
      withFileTypes: true,
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `failed listing workflow root '${input.workflowRoot}': ${error.message}`
          : `failed listing workflow root '${input.workflowRoot}'`,
    };
  }

  const candidateDirectories = directoryEntries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => {
      if (left.name === input.workflowId) {
        return -1;
      }
      if (right.name === input.workflowId) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });

  let preferredDirectoryError: string | undefined;
  for (const entry of candidateDirectories) {
    const workflowDirectory = path.join(input.workflowRoot, entry.name);
    const workflowJsonPath = path.join(workflowDirectory, "workflow.json");
    let text: string;
    try {
      text = await readFile(workflowJsonPath, "utf8");
    } catch (error) {
      if (entry.name === input.workflowId) {
        preferredDirectoryError =
          error instanceof Error
            ? error.message
            : "failed to read callee workflow.json";
      }
      continue;
    }
    const parsed = parseCalleeWorkflowJsonText(text);
    if (!parsed.ok) {
      if (entry.name === input.workflowId) {
        preferredDirectoryError = parsed.message;
      }
      continue;
    }
    if (parsed.raw["workflowId"] !== input.workflowId) {
      continue;
    }
    return {
      ok: true,
      raw: parsed.raw,
      workflowDirectory,
    };
  }

  if (preferredDirectoryError !== undefined) {
    return { ok: false, message: preferredDirectoryError };
  }
  return {
    ok: false,
    message: `workflow id '${input.workflowId}' was not found under workflow root '${input.workflowRoot}'`,
  };
}

export function resolveCalleeWorkflowEntry(input: {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly inferredManagerStepId?: string;
}): { ok: true; entry: string } | { ok: false; message: string } {
  const managerStepId = input.raw["managerStepId"];
  const entryStepId = input.raw["entryStepId"];
  let entry: string | undefined;
  if (typeof managerStepId === "string" && managerStepId.length > 0) {
    entry = managerStepId;
  } else if (input.inferredManagerStepId !== undefined) {
    entry = input.inferredManagerStepId;
  } else if (typeof entryStepId === "string" && entryStepId.length > 0) {
    entry = entryStepId;
  }
  if (entry === undefined) {
    return {
      ok: false,
      message:
        "callee workflow must declare managerStepId or entryStepId (or exactly one manager-role step)",
    };
  }
  return { ok: true, entry };
}

/**
 * When `workflowRoot` is available, ensures each cross-workflow step transition's
 * `toStepId` matches the step id where the callee run starts: `managerStepId` when
 * present, otherwise `entryStepId` (or an inferred single manager-role step).
 * Callee start steps are resolved from `managerStepId`, `entryStepId`, or a
 * single manager-role step only (not from rejected legacy top-level node alias fields on disk).
 */
export function validateCrossWorkflowCalleeEntryAlignmentSync(
  bundle: NormalizedWorkflowBundle,
  options: WorkflowValidationOptions,
  issues: ValidationIssue[],
): void {
  const workflowRoot = options.workflowRoot;
  if (workflowRoot === undefined || workflowRoot === "") {
    return;
  }
  const steps = bundle.workflow.steps;
  if (steps === undefined) {
    return;
  }

  const cwd = options.cwd ?? process.cwd();
  const resolvedRoot = path.isAbsolute(workflowRoot)
    ? workflowRoot
    : path.resolve(cwd, workflowRoot);

  const calleeEntryById = new Map<
    string,
    { status: "ok"; entry: string } | { status: "error"; message: string }
  >();

  function resolveCalleeEntry(
    calleeId: string,
  ): { ok: true; entry: string } | { ok: false; message: string } {
    const cached = calleeEntryById.get(calleeId);
    if (cached !== undefined) {
      return cached.status === "ok"
        ? { ok: true, entry: cached.entry }
        : { ok: false, message: cached.message };
    }

    try {
      const resolvedWorkflow = resolveCalleeWorkflowJsonByIdSync({
        workflowRoot: resolvedRoot,
        workflowId: calleeId,
      });
      if (!resolvedWorkflow.ok) {
        calleeEntryById.set(calleeId, {
          status: "error",
          message: resolvedWorkflow.message,
        });
        return { ok: false, message: resolvedWorkflow.message };
      }
      const inferred = inferSingleManagerStepIdFromRawSync({
        raw: resolvedWorkflow.raw,
        workflowDirectory: resolvedWorkflow.workflowDirectory,
      });
      if (!inferred.ok) {
        calleeEntryById.set(calleeId, {
          status: "error",
          message: inferred.message,
        });
        return { ok: false, message: inferred.message };
      }
      const resolved = resolveCalleeWorkflowEntry({
        raw: resolvedWorkflow.raw,
        ...(inferred.managerStepId === undefined
          ? {}
          : { inferredManagerStepId: inferred.managerStepId }),
      });
      if (!resolved.ok) {
        calleeEntryById.set(calleeId, {
          status: "error",
          message: resolved.message,
        });
        return { ok: false, message: resolved.message };
      }
      calleeEntryById.set(calleeId, { status: "ok", entry: resolved.entry });
      return { ok: true, entry: resolved.entry };
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "failed to read callee workflow.json";
      calleeEntryById.set(calleeId, { status: "error", message });
      return { ok: false, message };
    }
  }

  for (const [stepIndex, step] of steps.entries()) {
    const transitions = step.transitions ?? [];
    for (const [ti, transition] of transitions.entries()) {
      if (transition.toWorkflowId === undefined) {
        continue;
      }
      const calleeId = transition.toWorkflowId;
      if (!isSafeWorkflowName(calleeId)) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${stepIndex}].transitions[${ti}].toWorkflowId`,
            `must be a safe workflow directory name (got '${calleeId}')`,
          ),
        );
        continue;
      }
      const resolved = resolveCalleeEntry(calleeId);
      if (!resolved.ok) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${stepIndex}].transitions[${ti}].toWorkflowId`,
            `cannot load callee workflow '${calleeId}': ${resolved.message}`,
          ),
        );
        continue;
      }
      if (transition.toStepId !== resolved.entry) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${stepIndex}].transitions[${ti}].toStepId`,
            `must match callee start step '${resolved.entry}' (callee '${calleeId}': managerStepId, else entryStepId); cross-workflow step calls use the callee's step-addressed start target`,
          ),
        );
      }
    }
  }
}

export async function validateCrossWorkflowCalleeEntryAlignment(
  bundle: NormalizedWorkflowBundle,
  options: WorkflowValidationOptions,
  issues: ValidationIssue[],
): Promise<void> {
  const workflowRoot = options.workflowRoot;
  if (workflowRoot === undefined || workflowRoot === "") {
    return;
  }
  const steps = bundle.workflow.steps;
  if (steps === undefined) {
    return;
  }

  const cwd = options.cwd ?? process.cwd();
  const resolvedRoot = path.isAbsolute(workflowRoot)
    ? workflowRoot
    : path.resolve(cwd, workflowRoot);

  const calleeEntryById = new Map<
    string,
    { status: "ok"; entry: string } | { status: "error"; message: string }
  >();

  async function resolveCalleeEntry(
    calleeId: string,
  ): Promise<{ ok: true; entry: string } | { ok: false; message: string }> {
    const cached = calleeEntryById.get(calleeId);
    if (cached !== undefined) {
      return cached.status === "ok"
        ? { ok: true, entry: cached.entry }
        : { ok: false, message: cached.message };
    }

    try {
      const resolvedWorkflow = await resolveCalleeWorkflowJsonByIdAsync({
        workflowRoot: resolvedRoot,
        workflowId: calleeId,
      });
      if (!resolvedWorkflow.ok) {
        calleeEntryById.set(calleeId, {
          status: "error",
          message: resolvedWorkflow.message,
        });
        return { ok: false, message: resolvedWorkflow.message };
      }
      const inferred = await inferSingleManagerStepIdFromRawAsync({
        raw: resolvedWorkflow.raw,
        workflowDirectory: resolvedWorkflow.workflowDirectory,
      });
      if (!inferred.ok) {
        calleeEntryById.set(calleeId, {
          status: "error",
          message: inferred.message,
        });
        return { ok: false, message: inferred.message };
      }
      const resolved = resolveCalleeWorkflowEntry({
        raw: resolvedWorkflow.raw,
        ...(inferred.managerStepId === undefined
          ? {}
          : { inferredManagerStepId: inferred.managerStepId }),
      });
      if (!resolved.ok) {
        calleeEntryById.set(calleeId, {
          status: "error",
          message: resolved.message,
        });
        return { ok: false, message: resolved.message };
      }
      calleeEntryById.set(calleeId, { status: "ok", entry: resolved.entry });
      return { ok: true, entry: resolved.entry };
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "failed to read callee workflow.json";
      calleeEntryById.set(calleeId, { status: "error", message });
      return { ok: false, message };
    }
  }

  for (const [stepIndex, step] of steps.entries()) {
    const transitions = step.transitions ?? [];
    for (const [ti, transition] of transitions.entries()) {
      if (transition.toWorkflowId === undefined) {
        continue;
      }
      const calleeId = transition.toWorkflowId;
      if (!isSafeWorkflowName(calleeId)) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${stepIndex}].transitions[${ti}].toWorkflowId`,
            `must be a safe workflow directory name (got '${calleeId}')`,
          ),
        );
        continue;
      }
      const resolved = await resolveCalleeEntry(calleeId);
      if (!resolved.ok) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${stepIndex}].transitions[${ti}].toWorkflowId`,
            `cannot load callee workflow '${calleeId}': ${resolved.message}`,
          ),
        );
        continue;
      }
      if (transition.toStepId !== resolved.entry) {
        issues.push(
          makeIssue(
            "error",
            `workflow.steps[${stepIndex}].transitions[${ti}].toStepId`,
            `must match callee start step '${resolved.entry}' (callee '${calleeId}': managerStepId, else entryStepId); cross-workflow step calls use the callee's step-addressed start target`,
          ),
        );
      }
    }
  }
}

export function runSemanticValidation(
  bundle: NormalizedWorkflowBundle,
  issues: ValidationIssue[],
): void {
  const structuralEdges = getStructuralEdges(bundle.workflow);
  const structuralLoops = getStructuralLoops(bundle.workflow);
  const nodeIdSet = new Set(bundle.workflow.nodes.map((node) => node.id));
  const nodeOrderByNodeId = new Map(
    bundle.workflow.nodes.map((node, order) => [node.id, order]),
  );

  const seenNodeIds = new Set<string>();
  bundle.workflow.nodes.forEach((node, index) => {
    if (seenNodeIds.has(node.id)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.nodes[${index}].id`,
          `duplicate node id '${node.id}'`,
        ),
      );
      return;
    }
    seenNodeIds.add(node.id);

    const payload = getNormalizedNodePayload(bundle, node.id);
    if (!payload) {
      issues.push(
        makeIssue(
          "error",
          `nodePayloads.${node.nodeFile}`,
          "node payload file is missing",
        ),
      );
      return;
    }

    if (
      node.role === "manager" &&
      (payload.nodeType === "command" ||
        payload.nodeType === "container" ||
        payload.nodeType === "user-action" ||
        payload.nodeType === "addon")
    ) {
      issues.push(
        makeIssue(
          "error",
          `nodePayloads.${node.nodeFile}.nodeType`,
          "manager-role nodes must stay on the agent execution path",
        ),
      );
    }
    if (node.role !== "manager" && payload.managerType !== undefined) {
      issues.push(
        makeIssue(
          "error",
          `nodePayloads.${node.nodeFile}.managerType`,
          "managerType is valid only for manager-role nodes",
        ),
      );
    }

    if (
      payload.timeoutMs === undefined &&
      bundle.workflow.defaults.nodeTimeoutMs === DEFAULT_NODE_TIMEOUT_MS
    ) {
      issues.push(
        makeIssue(
          "warning",
          `nodePayloads.${node.nodeFile}.timeoutMs`,
          "not set; workflow default timeout will be applied",
        ),
      );
    }
  });

  structuralEdges.forEach((edge, index) => {
    if (!nodeIdSet.has(edge.from)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.steps[${index}].transitions`,
          "must reference an existing step id",
        ),
      );
    }
    if (!nodeIdSet.has(edge.to)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.steps[${index}].transitions`,
          "must reference an existing step id",
        ),
      );
    }
  });

  structuralLoops.forEach((loop, index) => {
    if (!nodeIdSet.has(loop.judgeNodeId)) {
      issues.push(
        makeIssue(
          "error",
          `workflow.loops[${index}].judgeNodeId`,
          "must reference an existing node id",
        ),
      );
      return;
    }
    const judgeNode = bundle.workflow.nodes.find(
      (node) => node.id === loop.judgeNodeId,
    );
    if (judgeNode?.kind !== "loop-judge") {
      issues.push(
        makeIssue(
          "error",
          `workflow.loops[${index}].judgeNodeId`,
          "must reference a loop-judge node",
        ),
      );
    }
  });

  const loopIntervals: Array<{
    readonly id: string;
    readonly startOrder: number;
    readonly endOrder: number;
  }> = [];
  structuralLoops.forEach((loop, index) => {
    const judgeOrder = nodeOrderByNodeId.get(loop.judgeNodeId);
    if (judgeOrder === undefined) {
      return;
    }

    const continueTargets = structuralEdges.filter(
      (edge) =>
        edge.from === loop.judgeNodeId && edge.when === loop.continueWhen,
    );
    if (continueTargets.length === 0) {
      issues.push(
        makeIssue(
          "error",
          `workflow.loops[${index}].continueWhen`,
          "must have at least one matching continue edge from the loop judge",
        ),
      );
    }
    continueTargets.forEach((edge, continueIndex) => {
      const targetOrder = nodeOrderByNodeId.get(edge.to);
      if (targetOrder === undefined) {
        return;
      }
      if (targetOrder <= judgeOrder) {
        loopIntervals.push({
          id: loop.id,
          startOrder: targetOrder,
          endOrder: judgeOrder,
        });
      }
      if (targetOrder > judgeOrder) {
        issues.push(
          makeIssue(
            "error",
            `workflow.loops[${index}].continueWhen`,
            `continue edge target '${edge.to}' must appear before loop judge '${loop.judgeNodeId}' in vertical order`,
          ),
        );
      }
      if (
        continueIndex > 0 &&
        targetOrder !== undefined &&
        targetOrder !== nodeOrderByNodeId.get(continueTargets[0]?.to ?? "")
      ) {
        issues.push(
          makeIssue(
            "warning",
            `workflow.loops[${index}].continueWhen`,
            "multiple continue targets produce a shared visual loop block based on the earliest target",
          ),
        );
      }
    });

    structuralEdges
      .filter(
        (edge) => edge.from === loop.judgeNodeId && edge.when === loop.exitWhen,
      )
      .forEach((edge) => {
        const targetOrder = nodeOrderByNodeId.get(edge.to);
        if (targetOrder === undefined) {
          return;
        }
        if (targetOrder <= judgeOrder) {
          issues.push(
            makeIssue(
              "error",
              `workflow.loops[${index}].exitWhen`,
              `exit edge target '${edge.to}' must appear after loop judge '${loop.judgeNodeId}' in vertical order`,
            ),
          );
        }
      });
  });

  for (let index = 0; index < loopIntervals.length; index += 1) {
    const current = loopIntervals[index];
    if (current === undefined) {
      continue;
    }
    for (
      let compareIndex = index + 1;
      compareIndex < loopIntervals.length;
      compareIndex += 1
    ) {
      const other = loopIntervals[compareIndex];
      if (other === undefined || current.id === other.id) {
        continue;
      }
      if (intervalsPartiallyOverlap(current, other)) {
        pushCrossingIntervalIssue(issues, bundle, {
          path: "workflow.loops",
          leftId: current.id,
          leftStartOrder: current.startOrder,
          rightId: other.id,
          rightStartOrder: other.startOrder,
          messagePrefix: "vertical loop scopes",
        });
      }
    }
  }

  if (
    bundle.workflow.defaults.maxLoopIterations === DEFAULT_MAX_LOOP_ITERATIONS
  ) {
    issues.push(
      makeIssue(
        "warning",
        "workflow.defaults.maxLoopIterations",
        "using default loop iteration value; consider explicit value per workflow",
      ),
    );
  }
}
