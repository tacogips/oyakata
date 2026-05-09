import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionOutput } from "./adapter";
import {
  err,
  ok,
  type Result,
  type CandidatePayloadResolutionError,
  type OutputArtifact,
} from "./engine-types";

export async function readCandidatePayloadFromFile(
  filePath: string,
): Promise<
  Result<Readonly<Record<string, unknown>>, CandidatePayloadResolutionError>
> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return err({
        message: `candidate file '${filePath}' must contain a JSON object`,
        retryable: true,
      });
    }
    return ok(parsed as Readonly<Record<string, unknown>>);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    return err({
      message: `unable to read candidate file '${filePath}': ${message}`,
      retryable: true,
    });
  }
}

export async function resolveCandidatePayload(input: {
  readonly expectedCandidatePath: string;
  readonly execution: AdapterExecutionOutput;
}): Promise<
  Result<Readonly<Record<string, unknown>>, CandidatePayloadResolutionError>
> {
  if (input.execution.candidateFilePath === undefined) {
    return ok(input.execution.payload);
  }

  const resolvedPath = path.isAbsolute(input.execution.candidateFilePath)
    ? input.execution.candidateFilePath
    : path.resolve(
        path.dirname(input.expectedCandidatePath),
        input.execution.candidateFilePath,
      );
  if (
    path.resolve(resolvedPath) !== path.resolve(input.expectedCandidatePath)
  ) {
    return err({
      message: `candidate file path must resolve to the reserved candidate path '${input.expectedCandidatePath}'`,
      retryable: false,
    });
  }
  return readCandidatePayloadFromFile(resolvedPath);
}

export async function readOutputPayloadArtifact(
  artifactDir: string,
): Promise<Result<OutputArtifact, string>> {
  const outputPath = path.join(artifactDir, "output.json");

  try {
    const outputRaw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(outputRaw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return err(`output artifact '${outputPath}' must contain a JSON object`);
    }
    return ok({
      payload: parsed as Readonly<Record<string, unknown>>,
      raw: outputRaw,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    return err(`unable to read output artifact '${outputPath}': ${message}`);
  }
}
