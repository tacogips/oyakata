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
        body: JSON.stringify({ runtimeVariables: { topic: "x" }, maxSteps: 1 }),
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
