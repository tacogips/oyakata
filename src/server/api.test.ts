import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { handleApiRequest } from "./api";
import { createWorkflowTemplate } from "../workflow/create";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-api-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("handleApiRequest", () => {
  test("serves web UI and health endpoint", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const uiRes = await handleApiRequest(new Request("http://localhost/"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get("content-type")).toContain("text/html");
    const uiText = await uiRes.text();
    expect(uiText).toContain("oyakata Workflow Runner");

    const healthRes = await handleApiRequest(new Request("http://localhost/healthz"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(healthRes.status).toBe(200);
  });

  test("lists and gets workflows", async () => {
    const root = await makeTempDir();
    const created = await createWorkflowTemplate("demo", { workflowRoot: root });
    expect(created.ok).toBe(true);

    const listRes = await handleApiRequest(new Request("http://localhost/api/workflows"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { workflows: string[] };
    expect(listJson.workflows).toContain("demo");

    const getRes = await handleApiRequest(new Request("http://localhost/api/workflows/demo"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { workflowName: string };
    expect(getJson.workflowName).toBe("demo");
  });

  test("validates and executes workflow", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", { method: "POST" }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = (await validateRes.json()) as { valid: boolean };
    expect(validateJson.valid).toBe(true);

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({
          runtimeVariables: { topic: "x" },
          maxSteps: 1,
          mockScenario: {
            "oyakata-manager": { provider: "scenario-mock", when: { always: true }, payload: { stage: "design" } },
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(executeRes.status).toBe(200);
    const executeJson = (await executeRes.json()) as { sessionId: string; status: string };
    expect(executeJson.sessionId).toContain("sess-");
    expect(executeJson.status).toBe("paused");

    const statusRes = await handleApiRequest(new Request(`http://localhost/api/sessions/${executeJson.sessionId}`), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(statusRes.status).toBe(200);

    const cancelRes = await handleApiRequest(
      new Request(`http://localhost/api/sessions/${executeJson.sessionId}/cancel`, { method: "POST" }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(cancelRes.status).toBe(200);
    const cancelJson = (await cancelRes.json()) as { accepted: boolean; status: string };
    expect(cancelJson.accepted).toBe(true);
    expect(cancelJson.status).toBe("cancelled");
  });

  test("executes asynchronously and lists sessions", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });
    const context = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    };

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({ async: true }),
      }),
      context,
    );
    expect(executeRes.status).toBe(202);
    const executeJson = (await executeRes.json()) as { sessionId: string; accepted: boolean };
    expect(executeJson.accepted).toBe(true);

    let foundSession = false;
    for (let index = 0; index < 20; index += 1) {
      const statusRes = await handleApiRequest(
        new Request(`http://localhost/api/sessions/${executeJson.sessionId}`),
        context,
      );
      if (statusRes.status === 200) {
        foundSession = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(foundSession).toBe(true);

    const listRes = await handleApiRequest(new Request("http://localhost/api/sessions"), context);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      sessions: Array<{ sessionId: string; workflowName: string; status: string }>;
    };
    expect(listJson.sessions.some((session) => session.sessionId === executeJson.sessionId)).toBe(true);
  });

  test("reruns a session from a specific node", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({ maxSteps: 1 }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(executeRes.status).toBe(200);
    const executeJson = (await executeRes.json()) as { sessionId: string };

    const rerunRes = await handleApiRequest(
      new Request(`http://localhost/api/sessions/${executeJson.sessionId}/rerun`, {
        method: "POST",
        body: JSON.stringify({
          fromNodeId: "workflow-output",
          mockScenario: {
            "workflow-output": {
              provider: "scenario-mock",
              when: { always: true },
              payload: { stage: "test-review" },
            },
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(rerunRes.status).toBe(200);
    const rerunJson = (await rerunRes.json()) as {
      sourceSessionId: string;
      sessionId: string;
      rerunFromNodeId: string;
    };
    expect(rerunJson.sourceSessionId).toBe(executeJson.sessionId);
    expect(rerunJson.sessionId).not.toBe(executeJson.sessionId);
    expect(rerunJson.rerunFromNodeId).toBe("workflow-output");
  });

  test("honors no-exec mode", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", { method: "POST" }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        noExec: true,
      },
    );

    expect(executeRes.status).toBe(403);
  });

  test("updates workflow with revision conflict protection", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const getRes = await handleApiRequest(new Request("http://localhost/api/workflows/demo"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      revision: string;
      bundle: {
        workflow: Record<string, unknown>;
        workflowVis: Record<string, unknown>;
        nodePayloads: Record<string, unknown>;
      };
    };

    const updatedWorkflow = {
      ...getJson.bundle.workflow,
      description: "updated description",
    };

    const putRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo", {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: getJson.revision,
          bundle: {
            workflow: updatedWorkflow,
            workflowVis: getJson.bundle.workflowVis,
            nodePayloads: getJson.bundle.nodePayloads,
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { revision: string };
    expect(putJson.revision).not.toBe(getJson.revision);

    const stalePutRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo", {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: getJson.revision,
          bundle: {
            workflow: updatedWorkflow,
            workflowVis: getJson.bundle.workflowVis,
            nodePayloads: getJson.bundle.nodePayloads,
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(stalePutRes.status).toBe(409);
  });
});
