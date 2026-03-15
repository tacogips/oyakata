import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  handleApiRequest,
  resolveDefaultUiDistRoot,
  type ApiContext,
} from "./api";
import { detectFrontendMode } from "./ui-assets";
import type {
  CancelWorkflowExecutionResponse,
  ExecuteWorkflowResponse,
  RerunWorkflowResponse,
  SaveWorkflowResponse,
  SessionsResponse,
  ValidationResponse,
  WorkflowExecutionStateResponse,
  WorkflowListResponse,
  WorkflowResponse,
} from "../shared/ui-contract";
import { createWorkflowTemplate } from "../workflow/create";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-api-test-"));
  tempDirs.push(directory);
  return directory;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeDefaultTemplateScenario(
  stage = "design",
): Readonly<Record<string, unknown>> {
  return {
    "oyakata-manager": {
      provider: "scenario-mock",
      when: { always: true },
      payload: { stage },
    },
    "main-oyakata": {
      provider: "scenario-mock",
      when: { always: true },
      payload: { stage: "dispatch" },
    },
    "workflow-input": {
      provider: "scenario-mock",
      when: { always: true },
      payload: { stage: "implement" },
    },
    "workflow-output": {
      provider: "scenario-mock",
      when: { always: true },
      payload: { stage: "review" },
    },
  };
}

describe("handleApiRequest", () => {
  test("returns a clear unavailable page when built UI assets are missing", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const uiRes = await handleApiRequest(new Request("http://localhost/"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot: path.join(root, "missing-ui-dist"),
    });
    expect(uiRes.status).toBe(503);
    expect(uiRes.headers.get("content-type")).toContain("text/html");
    const uiText = await uiRes.text();
    expect(uiText).toContain("oyakata UI is unavailable");
    expect(uiText).toContain("ui/dist/");
    expect(uiText).toContain("bun run build:ui");

    const healthRes = await handleApiRequest(
      new Request("http://localhost/healthz"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(healthRes.status).toBe(200);
  });

  test("lists no workflows when the workflow root does not exist yet", async () => {
    const root = await makeTempDir();
    const missingWorkflowRoot = path.join(root, "missing-workflows");

    const listRes = await handleApiRequest(
      new Request("http://localhost/api/workflows"),
      {
        workflowRoot: missingWorkflowRoot,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );

    expect(listRes.status).toBe(200);
    const listJson = await readJson<WorkflowListResponse>(listRes);
    expect(listJson.workflows).toEqual([]);
  });

  test("serves built UI assets for root and non-api asset requests", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    await mkdir(path.join(uiDistRoot, "assets"), { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "index.html"),
      "<!doctype html><html><body><div id='app'>solid-ui</div></body></html>",
    );
    await writeFile(
      path.join(uiDistRoot, "assets", "entry.js"),
      "console.log('ui asset');",
    );

    const rootRes = await handleApiRequest(new Request("http://localhost/"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot,
    });
    expect(rootRes.status).toBe(200);
    await expect(rootRes.text()).resolves.toContain("solid-ui");

    const assetRes = await handleApiRequest(
      new Request("http://localhost/assets/entry.js"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toContain("text/javascript");
    await expect(assetRes.text()).resolves.toContain("ui asset");
  });

  test("serves common built frontend asset types with stable content types", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    await mkdir(path.join(uiDistRoot, "assets"), { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "index.html"),
      "<!doctype html><html><body><div id='app'>ui</div></body></html>",
    );
    await writeFile(
      path.join(uiDistRoot, "assets", "entry.mjs"),
      "export const value = 1;\n",
      "utf8",
    );
    await writeFile(
      path.join(uiDistRoot, "assets", "entry.js.map"),
      '{"version":3}',
      "utf8",
    );
    await writeFile(
      path.join(uiDistRoot, "assets", "font.woff2"),
      "font-data",
      "utf8",
    );
    await writeFile(
      path.join(uiDistRoot, "assets", "image.webp"),
      "image-data",
      "utf8",
    );

    const mjsRes = await handleApiRequest(
      new Request("http://localhost/assets/entry.mjs"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    expect(mjsRes.status).toBe(200);
    expect(mjsRes.headers.get("content-type")).toContain("text/javascript");

    const mapRes = await handleApiRequest(
      new Request("http://localhost/assets/entry.js.map"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    expect(mapRes.status).toBe(200);
    expect(mapRes.headers.get("content-type")).toContain("application/json");

    const fontRes = await handleApiRequest(
      new Request("http://localhost/assets/font.woff2"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    expect(fontRes.status).toBe(200);
    expect(fontRes.headers.get("content-type")).toContain("font/woff2");

    const imageRes = await handleApiRequest(
      new Request("http://localhost/assets/image.webp"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("content-type")).toContain("image/webp");
  });

  test("returns UI bootstrap config with the default frontend mode", async () => {
    const root = await makeTempDir();

    const res = await handleApiRequest(
      new Request("http://localhost/api/ui-config"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        fixedWorkflowName: "demo",
        readOnly: true,
        noExec: true,
        uiDistRoot: path.join(root, "missing-ui-dist"),
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      fixedWorkflowName: "demo",
      readOnly: true,
      noExec: true,
      frontend: "solid-dist",
    });
  });

  test("detects frontend mode from the checked-in UI entrypoint when no override is provided", () => {
    expect(detectFrontendMode()).toBe("solid-dist");
  });

  test("prefers built frontend metadata over source-entrypoint detection", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    const uiSourceRoot = path.join(root, "ui", "src");
    await mkdir(uiDistRoot, { recursive: true });
    await mkdir(uiSourceRoot, { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "frontend-mode.json"),
      JSON.stringify({ frontend: "solid-dist" }),
      "utf8",
    );
    await writeFile(path.join(uiSourceRoot, "main.ts"), "export {};\n", "utf8");

    const fakeModuleUrl = new URL(
      `file://${path.join(root, "src", "server", "api.ts")}`,
    ).href;
    expect(
      detectFrontendMode({
        uiDistRoot,
        frontendModeModuleUrl: fakeModuleUrl,
      }),
    ).toBe("solid-dist");
  });

  test("scopes built frontend metadata lookup to the overridden package root", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui", "dist");
    const uiSourceRoot = path.join(root, "ui", "src");
    await mkdir(uiDistRoot, { recursive: true });
    await mkdir(uiSourceRoot, { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "frontend-mode.json"),
      JSON.stringify({ frontend: "solid-dist" }),
      "utf8",
    );
    await writeFile(path.join(uiSourceRoot, "main.ts"), "export {};\n", "utf8");

    const fakeModuleUrl = new URL(
      `file://${path.join(root, "src", "server", "api.ts")}`,
    ).href;
    expect(
      detectFrontendMode({
        frontendModeModuleUrl: fakeModuleUrl,
      }),
    ).toBe("solid-dist");
  });

  test("rejects invalid built frontend metadata explicitly", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    await mkdir(uiDistRoot, { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "frontend-mode.json"),
      JSON.stringify({ frontend: "unsupported-dist" }),
      "utf8",
    );

    expect(() => detectFrontendMode({ uiDistRoot })).toThrow(
      /unsupported frontend mode/i,
    );

    const res = await handleApiRequest(
      new Request("http://localhost/api/ui-config"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/unsupported frontend mode/i),
    });
  });

  test("detects a Solid frontend entrypoint from a package-relative ui/src/main.tsx", async () => {
    const root = await makeTempDir();
    const uiSourceRoot = path.join(root, "ui", "src");
    await mkdir(uiSourceRoot, { recursive: true });
    await writeFile(
      path.join(uiSourceRoot, "main.tsx"),
      "export {};\n",
      "utf8",
    );

    const fakeModuleUrl = new URL(
      `file://${path.join(root, "src", "server", "api.ts")}`,
    ).href;
    expect(detectFrontendMode({}, fakeModuleUrl)).toBe("solid-dist");
  });

  test("rejects a legacy Svelte entrypoint instead of silently defaulting", async () => {
    const root = await makeTempDir();
    const uiSourceRoot = path.join(root, "ui", "src");
    await mkdir(uiSourceRoot, { recursive: true });
    await writeFile(path.join(uiSourceRoot, "main.ts"), "export {};\n", "utf8");

    const fakeModuleUrl = new URL(
      `file://${path.join(root, "src", "server", "api.ts")}`,
    ).href;
    expect(() =>
      detectFrontendMode({ frontendModeModuleUrl: fakeModuleUrl }),
    ).toThrow(/legacy Svelte entrypoint/i);

    const res = await handleApiRequest(
      new Request("http://localhost/api/ui-config"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        frontendModeModuleUrl: fakeModuleUrl,
      },
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/legacy Svelte entrypoint/i),
    });
  });

  test("rejects a missing checked-in frontend entrypoint instead of silently defaulting", async () => {
    const root = await makeTempDir();
    const uiSourceRoot = path.join(root, "ui", "src");
    await mkdir(uiSourceRoot, { recursive: true });

    const fakeModuleUrl = new URL(
      `file://${path.join(root, "src", "server", "api.ts")}`,
    ).href;
    expect(() =>
      detectFrontendMode({ frontendModeModuleUrl: fakeModuleUrl }),
    ).toThrow(/unable to detect Solid frontend/i);

    const res = await handleApiRequest(
      new Request("http://localhost/api/ui-config"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        frontendModeModuleUrl: fakeModuleUrl,
      },
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/unable to detect Solid frontend/i),
    });
  });

  test("returns UI bootstrap config with an overridden frontend mode", async () => {
    const root = await makeTempDir();

    const res = await handleApiRequest(
      new Request("http://localhost/api/ui-config"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        frontendMode: "solid-dist",
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      fixedWorkflowName: null,
      readOnly: false,
      noExec: false,
      frontend: "solid-dist",
    });
  });

  test("uses an explicit frontend override even when a legacy Svelte entrypoint is present", async () => {
    const root = await makeTempDir();
    const uiSourceRoot = path.join(root, "ui", "src");
    await mkdir(uiSourceRoot, { recursive: true });
    await writeFile(path.join(uiSourceRoot, "main.ts"), "export {};\n", "utf8");

    const fakeModuleUrl = new URL(
      `file://${path.join(root, "src", "server", "api.ts")}`,
    ).href;
    const res = await handleApiRequest(
      new Request("http://localhost/api/ui-config"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        frontendMode: "solid-dist",
        frontendModeModuleUrl: fakeModuleUrl,
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      frontend: "solid-dist",
    });
  });

  test("resolves default ui/dist relative to the package root instead of cwd", () => {
    const fakeBuiltModuleUrl = new URL(
      "file:///tmp/oyakata-installed/dist/server/api.js",
    ).href;
    expect(resolveDefaultUiDistRoot(fakeBuiltModuleUrl)).toBe(
      path.join("/tmp/oyakata-installed", "ui", "dist"),
    );

    const fakeSourceModuleUrl = new URL(
      "file:///tmp/oyakata-dev/src/server/api.ts",
    ).href;
    expect(resolveDefaultUiDistRoot(fakeSourceModuleUrl)).toBe(
      path.join("/tmp/oyakata-dev", "ui", "dist"),
    );
  });

  test("serves built UI assets when ui/dist output is available", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    await mkdir(path.join(uiDistRoot, "assets"), { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "index.html"),
      '<!doctype html><html><body><div id="app">solid build</div><script src="/assets/app.js"></script></body></html>',
      "utf8",
    );
    await writeFile(
      path.join(uiDistRoot, "assets", "app.js"),
      "console.log('solid asset');",
      "utf8",
    );
    await writeFile(
      path.join(uiDistRoot, "favicon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "utf8",
    );

    const uiRes = await handleApiRequest(new Request("http://localhost/"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot,
    });
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get("content-type")).toContain("text/html");
    await expect(uiRes.text()).resolves.toContain("solid build");

    const assetRes = await handleApiRequest(
      new Request("http://localhost/assets/app.js"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toContain("text/javascript");
    await expect(assetRes.text()).resolves.toContain("solid asset");

    const iconRes = await handleApiRequest(
      new Request("http://localhost/favicon.svg"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    expect(iconRes.status).toBe(200);
    expect(iconRes.headers.get("content-type")).toContain("image/svg+xml");
    await expect(iconRes.text()).resolves.toContain("<svg");

    const configRes = await handleApiRequest(
      new Request("http://localhost/api/ui-config"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );
    await expect(configRes.json()).resolves.toMatchObject({
      fixedWorkflowName: null,
      readOnly: false,
      noExec: false,
      frontend: "solid-dist",
    });
  });

  test("does not serve encoded traversal-like asset paths outside the built UI root", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    await mkdir(uiDistRoot, { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "index.html"),
      "<!doctype html><html><body>safe</body></html>",
      "utf8",
    );
    await writeFile(path.join(root, "secret.txt"), "do not expose", "utf8");

    const res = await handleApiRequest(
      new Request("http://localhost/%2e%2e%2fsecret.txt"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        uiDistRoot,
      },
    );

    expect(res.status).toBe(404);
  });

  test("lists and gets workflows", async () => {
    const root = await makeTempDir();
    const created = await createWorkflowTemplate("demo", {
      workflowRoot: root,
    });
    expect(created.ok).toBe(true);

    const listRes = await handleApiRequest(
      new Request("http://localhost/api/workflows"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(listRes.status).toBe(200);
    const listJson = await readJson<WorkflowListResponse>(listRes);
    expect(listJson.workflows).toContain("demo");

    const getRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(getRes.status).toBe(200);
    const getJson = await readJson<WorkflowResponse>(getRes);
    expect(getJson.workflowName).toBe("demo");
    expect(getJson.derivedVisualization.length).toBeGreaterThan(0);
    expect(getJson.derivedVisualization[0]?.id).toBe("oyakata-manager");
    expect(getJson.derivedVisualization[0]?.indent).toBe(0);
    expect(
      getJson.derivedVisualization.find(
        (entry) => entry.id === "workflow-input",
      )?.color,
    ).toBe("group:main");
  });

  test("creates workflows from the API", async () => {
    const root = await makeTempDir();

    const createRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "browser-demo" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(createRes.status).toBe(201);
    const createJson = await readJson<WorkflowResponse>(createRes);
    expect(createJson.workflowName).toBe("browser-demo");
    expect(createJson.bundle.workflow.description).toBe("New workflow");
    expect(
      createJson.bundle.nodePayloads["oyakata-manager"]?.executionBackend,
    ).toBe("codex-agent");
    expect(createJson.bundle.nodePayloads["oyakata-manager"]?.model).toBe(
      "gpt-5",
    );
    expect(
      createJson.bundle.nodePayloads["workflow-output"]?.executionBackend,
    ).toBe("codex-agent");
    expect(createJson.bundle.nodePayloads["workflow-output"]?.model).toBe(
      "gpt-5",
    );
    expect(createJson.revision).toEqual(expect.any(String));

    const duplicateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "browser-demo" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(duplicateRes.status).toBe(409);
  });

  test("rejects invalid workflow names from the API", async () => {
    const root = await makeTempDir();

    const createRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "../bad-name" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );

    expect(createRes.status).toBe(400);
    await expect(createRes.json()).resolves.toMatchObject({
      error: "invalid workflow name '../bad-name'",
    });
  });

  test("rejects browser workflow creation in fixed and read-only serve modes", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const readOnlyRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "blocked-by-readonly" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        readOnly: true,
      },
    );
    expect(readOnlyRes.status).toBe(403);
    await expect(readOnlyRes.json()).resolves.toMatchObject({
      error: "read-only mode enabled",
    });

    const fixedWorkflowRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "blocked-by-fixed" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        fixedWorkflowName: "demo",
      },
    );
    expect(fixedWorkflowRes.status).toBe(403);
    await expect(fixedWorkflowRes.json()).resolves.toMatchObject({
      error: "cannot create workflows in fixed workflow mode",
    });
  });

  test("validates and executes workflow", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = await readJson<ValidationResponse>(validateRes);
    expect(validateJson.valid).toBe(true);

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({
          runtimeVariables: {
            topic: "x",
            humanInput: { request: "start demo workflow" },
          },
          maxSteps: 1,
          mockScenario: makeDefaultTemplateScenario(),
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(executeRes.status).toBe(200);
    const executeJson = await readJson<ExecuteWorkflowResponse>(executeRes);
    expect(executeJson.workflowExecutionId).toBe(executeJson.sessionId);
    expect(executeJson.sessionId).toContain("sess-");
    expect(executeJson.status).toBe("paused");

    const statusRes = await handleApiRequest(
      new Request(
        `http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}`,
      ),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(statusRes.status).toBe(200);
    const statusJson =
      await readJson<WorkflowExecutionStateResponse>(statusRes);
    expect(statusJson.workflowExecutionId).toBe(
      executeJson.workflowExecutionId,
    );
    expect(statusJson.sessionId).toBe(executeJson.sessionId);

    const cancelRes = await handleApiRequest(
      new Request(
        `http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}/cancel`,
        { method: "POST" },
      ),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(cancelRes.status).toBe(200);
    const cancelJson =
      await readJson<CancelWorkflowExecutionResponse>(cancelRes);
    expect(cancelJson.accepted).toBe(true);
    expect(cancelJson.status).toBe("cancelled");
    expect(cancelJson.workflowExecutionId).toBe(
      executeJson.workflowExecutionId,
    );
    expect(cancelJson.sessionId).toBe(executeJson.sessionId);
  });

  test("supports legacy session status and cancel aliases with workflowExecutionId fields", async () => {
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
        body: JSON.stringify({
          runtimeVariables: {
            topic: "x",
            humanInput: { request: "start demo workflow" },
          },
          maxSteps: 1,
          mockScenario: makeDefaultTemplateScenario(),
        }),
      }),
      context,
    );
    expect(executeRes.status).toBe(200);
    const executeJson = await readJson<ExecuteWorkflowResponse>(executeRes);

    const legacyStatusRes = await handleApiRequest(
      new Request(`http://localhost/api/sessions/${executeJson.sessionId}`),
      context,
    );
    expect(legacyStatusRes.status).toBe(200);
    const legacyStatusJson =
      await readJson<WorkflowExecutionStateResponse>(legacyStatusRes);
    expect(legacyStatusJson.workflowExecutionId).toBe(
      executeJson.workflowExecutionId,
    );
    expect(legacyStatusJson.sessionId).toBe(executeJson.sessionId);
    expect(legacyStatusJson.status).toBe(executeJson.status);

    const legacyCancelRes = await handleApiRequest(
      new Request(
        `http://localhost/api/sessions/${executeJson.sessionId}/cancel`,
        { method: "POST" },
      ),
      context,
    );
    expect(legacyCancelRes.status).toBe(200);
    const legacyCancelJson =
      await readJson<CancelWorkflowExecutionResponse>(legacyCancelRes);
    expect(legacyCancelJson.accepted).toBe(true);
    expect(legacyCancelJson.status).toBe("cancelled");
    expect(legacyCancelJson.workflowExecutionId).toBe(
      executeJson.workflowExecutionId,
    );
    expect(legacyCancelJson.sessionId).toBe(executeJson.sessionId);
  });

  test("validates an in-memory bundle before save", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const getRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(getRes.status).toBe(200);
    const getJson = await readJson<WorkflowResponse>(getRes);

    const invalidBundle = {
      ...getJson.bundle,
      workflowVis: {
        ...getJson.bundle.workflowVis,
        nodes: [{ id: "oyakata-manager", order: 0 }],
      },
    };

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
        body: JSON.stringify({ bundle: invalidBundle }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = await readJson<ValidationResponse>(validateRes);
    expect(validateJson.valid).toBe(false);
    expect(
      validateJson.issues?.some((issue) => issue.path === "workflowVis.nodes"),
    ).toBe(true);
  });

  test("rejects malformed array-shaped workflow bundle sections at the route boundary", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });
    const context: ApiContext = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    };

    const invalidSaveRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo", {
        method: "PUT",
        body: JSON.stringify({
          bundle: {
            workflow: [],
            workflowVis: {},
            nodePayloads: {},
          },
        }),
      }),
      context,
    );
    expect(invalidSaveRes.status).toBe(400);
    await expect(invalidSaveRes.json()).resolves.toEqual({
      error: "bundle.workflow is required",
    });

    const invalidValidateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
        body: JSON.stringify({
          bundle: {
            workflow: {},
            workflowVis: [],
            nodePayloads: {},
          },
        }),
      }),
      context,
    );
    expect(invalidValidateRes.status).toBe(200);
    await expect(invalidValidateRes.json()).resolves.toEqual({
      valid: false,
      error: "bundle.workflowVis is required",
    });
  });

  test("validates a bundle loaded from the GET endpoint", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const getRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(getRes.status).toBe(200);
    const getJson = await readJson<WorkflowResponse>(getRes);

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
        body: JSON.stringify({ bundle: getJson.bundle }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = await readJson<ValidationResponse>(validateRes);
    expect(validateJson.valid).toBe(true);
    expect(
      validateJson.issues?.some(
        (issue) => issue.message === "node payload file is missing",
      ),
    ).toBe(false);
  });

  test("returns warnings for valid in-memory bundle validation", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
        body: JSON.stringify({
          bundle: {
            workflow: {
              workflowId: "demo",
              description: "demo",
              defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
              managerNodeId: "oyakata-manager",
              subWorkflows: [],
              nodes: [
                {
                  id: "oyakata-manager",
                  kind: "manager",
                  nodeFile: "node-oyakata-manager.json",
                  completion: { type: "none" },
                },
                {
                  id: "worker-1",
                  kind: "task",
                  nodeFile: "node-worker-1.json",
                  completion: { type: "none" },
                },
              ],
              edges: [],
              loops: [],
              branching: { mode: "fan-out" },
            },
            workflowVis: {
              nodes: [
                { id: "oyakata-manager", x: 10, y: 10, width: 100, height: 80 },
                { id: "worker-1", x: 200, y: 10, width: 100, height: 80 },
              ],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
            nodePayloads: {
              "node-oyakata-manager.json": {
                id: "oyakata-manager",
                model: "tacogips/codex-agent",
                promptTemplate: "manager",
                variables: {},
              },
              "node-worker-1.json": {
                id: "worker-1",
                model: "tacogips/codex-agent",
                promptTemplate: "worker",
                variables: {},
              },
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
    expect(validateRes.status).toBe(200);
    const validateJson = await readJson<ValidationResponse>(validateRes);
    expect(validateJson.valid).toBe(true);
    expect(validateJson.warnings?.length ?? 0).toBeGreaterThan(0);
    expect(
      validateJson.issues?.some(
        (issue) => issue.path === "workflowVis.viewport",
      ),
    ).toBe(true);
    expect(
      validateJson.issues?.some(
        (issue) => issue.path === "workflow.defaults.maxLoopIterations",
      ),
    ).toBe(true);
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
    const executeJson = await readJson<ExecuteWorkflowResponse>(executeRes);
    expect(executeJson.accepted).toBe(true);
    expect(executeJson.workflowExecutionId).toBe(executeJson.sessionId);

    let foundSession = false;
    for (let index = 0; index < 20; index += 1) {
      const statusRes = await handleApiRequest(
        new Request(
          `http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}`,
        ),
        context,
      );
      if (statusRes.status === 200) {
        foundSession = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(foundSession).toBe(true);

    const listRes = await handleApiRequest(
      new Request("http://localhost/api/sessions"),
      context,
    );
    expect(listRes.status).toBe(200);
    const listJson = await readJson<SessionsResponse>(listRes);
    expect(
      listJson.sessions.some(
        (session) =>
          session.workflowExecutionId === executeJson.workflowExecutionId &&
          session.sessionId === executeJson.sessionId,
      ),
    ).toBe(true);

    for (let index = 0; index < 40; index += 1) {
      const statusRes = await handleApiRequest(
        new Request(
          `http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}`,
        ),
        context,
      );
      if (statusRes.status !== 200) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const sessionJson =
        await readJson<WorkflowExecutionStateResponse>(statusRes);
      if (["completed", "failed", "cancelled"].includes(sessionJson.status)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  test("reruns a session from a specific node", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({
          runtimeVariables: { humanInput: { request: "start demo workflow" } },
          maxSteps: 1,
          mockScenario: makeDefaultTemplateScenario("manager"),
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(executeRes.status).toBe(200);
    const executeJson = await readJson<ExecuteWorkflowResponse>(executeRes);

    const rerunRes = await handleApiRequest(
      new Request(
        `http://localhost/api/sessions/${executeJson.sessionId}/rerun`,
        {
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
        },
      ),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(rerunRes.status).toBe(200);
    const rerunJson = await readJson<RerunWorkflowResponse>(rerunRes);
    expect(rerunJson.sourceWorkflowExecutionId).toBe(
      executeJson.workflowExecutionId,
    );
    expect(rerunJson.sourceSessionId).toBe(executeJson.sessionId);
    expect(rerunJson.workflowExecutionId).toBe(rerunJson.sessionId);
    expect(rerunJson.workflowExecutionId).not.toBe(
      executeJson.workflowExecutionId,
    );
    expect(rerunJson.sessionId).not.toBe(executeJson.sessionId);
    expect(rerunJson.rerunFromNodeId).toBe("workflow-output");
  });

  test("honors no-exec mode", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
      }),
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

    const getRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo"),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(getRes.status).toBe(200);
    const getJson = await readJson<WorkflowResponse>(getRes);

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
    const putJson = await readJson<SaveWorkflowResponse>(putRes);
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
