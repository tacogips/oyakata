import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  executeWorkflow,
  getRuntimeSessionView,
  getSession,
  inspectWorkflow,
  listSessions,
  resumeWorkflow,
} from "./lib";
import { createWorkflowTemplate } from "./workflow/create";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-lib-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("library api", () => {
  test("inspects workflow and executes/resumes via library functions", async () => {
    const root = await makeTempDir();
    const created = await createWorkflowTemplate("demo", { workflowRoot: root });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const options = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      cwd: root,
    };

    const summary = await inspectWorkflow("demo", options);
    expect(summary.workflowName).toBe("demo");

    const paused = await executeWorkflow({
      workflowName: "demo",
      ...options,
      maxSteps: 1,
    });
    expect(paused.status).toBe("paused");
    expect(paused.exitCode).toBe(4);

    const sessionBeforeResume = await getSession(paused.sessionId, options);
    expect(sessionBeforeResume.status).toBe("paused");

    const resumed = await resumeWorkflow({
      ...options,
      sessionId: paused.sessionId,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.exitCode).toBe(0);

    const sessions = await listSessions(options);
    expect(sessions.some((entry) => entry.sessionId === paused.sessionId)).toBe(true);

    const runtimeView = await getRuntimeSessionView(paused.sessionId, options);
    expect(runtimeView.nodeExecutions.length).toBeGreaterThan(0);
    expect(runtimeView.nodeLogs.length).toBeGreaterThan(0);
  });
});
