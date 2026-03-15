import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "./result";

export interface RevisionFailure {
  readonly code: "NOT_FOUND" | "IO";
  readonly message: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function computeWorkflowRevisionFromFiles(
  workflowDirectory: string,
  nodeFiles: readonly string[],
): Promise<Result<string, RevisionFailure>> {
  const sortedNodeFiles = [...nodeFiles].sort((a, b) => a.localeCompare(b));
  const files = ["workflow.json", "workflow-vis.json", ...sortedNodeFiles];

  try {
    const chunks: string[] = [];
    for (const fileName of files) {
      const filePath = path.join(workflowDirectory, fileName);
      const content = await readFile(filePath, "utf8");
      chunks.push(`${fileName}\n${content}`);
    }
    const digest = sha256(chunks.join("\n---\n"));
    return ok(`sha256:${digest}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("ENOENT")) {
      return err({
        code: "NOT_FOUND",
        message: `workflow file is missing: ${message}`,
      });
    }
    return err({
      code: "IO",
      message: `failed computing workflow revision: ${message}`,
    });
  }
}
