import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MockNodeScenario } from "../workflow/adapter";
import type { ParsedOptions, WorkflowExecutionExport } from "./types";

export async function readRuntimeVariables(
  pathToJson: string,
): Promise<Readonly<Record<string, unknown>>> {
  const content = await readFile(pathToJson, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime variables file must contain a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export async function readGraphqlVariables(
  value: string | undefined,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (value === undefined) {
    return undefined;
  }
  const content =
    value.startsWith("@") && value.length > 1
      ? await readFile(value.slice(1), "utf8")
      : value;
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GraphQL variables must be a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

async function readJsonValueFromFile(filePath: string): Promise<unknown> {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as unknown;
}

export async function readDirectCallMessage(
  parsedOptions: ParsedOptions,
): Promise<unknown | undefined> {
  if (
    parsedOptions.messageJson !== undefined &&
    parsedOptions.messageFile !== undefined
  ) {
    throw new Error("use only one of --message-json or --message-file");
  }
  if (parsedOptions.messageJson !== undefined) {
    return JSON.parse(parsedOptions.messageJson) as unknown;
  }
  if (parsedOptions.messageFile !== undefined) {
    return readJsonValueFromFile(parsedOptions.messageFile);
  }
  return undefined;
}

async function readMockScenario(pathToJson: string): Promise<MockNodeScenario> {
  const content = await readFile(pathToJson, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "mock scenario file must contain a JSON object keyed by step id",
    );
  }
  return parsed as MockNodeScenario;
}

export async function readMockScenarioOption(
  pathToJson: string | undefined,
): Promise<Readonly<{ mockScenario?: MockNodeScenario }>> {
  if (pathToJson === undefined) {
    return {};
  }
  return {
    mockScenario: await readMockScenario(pathToJson),
  };
}

export async function writeExportFile(
  filePath: string,
  payload: WorkflowExecutionExport,
): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  await writeFile(
    resolvedPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  return resolvedPath;
}

export async function writeTextFile(
  filePath: string,
  content: string,
): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  await writeFile(resolvedPath, content, "utf8");
  return resolvedPath;
}
