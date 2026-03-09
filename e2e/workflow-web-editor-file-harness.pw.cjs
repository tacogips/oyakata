const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { expect, test } = require("@playwright/test");

const sampleBundle = {
  workflow: {
    workflowId: "browser-demo",
    description: "New workflow",
    defaults: {
      maxLoopIterations: 3,
      nodeTimeoutMs: 120000,
    },
    prompts: {
      oyakataPromptTemplate:
        "Coordinate {{workflowId}} so each node and sub-workflow works for a clear reason and returns the value needed downstream.",
      workerSystemPromptTemplate:
        "Work only on the assigned node task, use the provided workflow context, and return the business JSON payload requested by the node.",
    },
    managerNodeId: "oyakata-manager",
    subWorkflows: [
      {
        id: "main",
        description: "Main sub-workflow",
        managerNodeId: "main-oyakata",
        inputNodeId: "workflow-input",
        outputNodeId: "workflow-output",
        nodeIds: ["main-oyakata", "workflow-input", "workflow-output"],
        inputSources: [{ type: "human-input" }],
        block: { type: "plain" },
      },
    ],
    nodes: [
      {
        id: "oyakata-manager",
        nodeFile: "node-oyakata-manager.json",
        kind: "root-manager",
        completion: { type: "none" },
      },
      {
        id: "main-oyakata",
        nodeFile: "node-main-oyakata.json",
        kind: "sub-manager",
        completion: { type: "none" },
      },
      {
        id: "workflow-input",
        nodeFile: "node-workflow-input.json",
        kind: "input",
        completion: { type: "none" },
      },
      {
        id: "workflow-output",
        nodeFile: "node-workflow-output.json",
        kind: "output",
        completion: { type: "none" },
      },
    ],
    edges: [{ from: "workflow-input", to: "workflow-output", when: "always" }],
    loops: [],
    branching: { mode: "fan-out" },
  },
  workflowVis: {
    nodes: [
      { id: "oyakata-manager", order: 0 },
      { id: "main-oyakata", order: 1 },
      { id: "workflow-input", order: 2 },
      { id: "workflow-output", order: 3 },
    ],
    uiMeta: { layout: "vertical" },
  },
  nodePayloads: {
    "oyakata-manager": {
      id: "oyakata-manager",
      model: "gpt-5",
      executionBackend: "tacogips/codex-agent",
      promptTemplate: "Coordinate workflow execution for {{workflowId}}",
      variables: { workflowId: "browser-demo" },
    },
    "main-oyakata": {
      id: "main-oyakata",
      model: "gpt-5",
      executionBackend: "tacogips/codex-agent",
      promptTemplate:
        "Translate the parent oyakata instruction into this sub-workflow's child work for {{workflowId}}",
      variables: { workflowId: "browser-demo" },
    },
    "workflow-input": {
      id: "workflow-input",
      model: "gpt-5",
      executionBackend: "tacogips/codex-agent",
      promptTemplate:
        "Normalize the received sub-workflow instruction into workflow input",
      variables: {},
    },
    "workflow-output": {
      id: "workflow-output",
      model: "gpt-5",
      executionBackend: "tacogips/codex-agent",
      promptTemplate: "Finalize workflow output",
      variables: {},
    },
  },
};

const sampleDerivedVisualization = [
  { id: "oyakata-manager", order: 0, indent: 0, color: "default" },
  { id: "main-oyakata", order: 1, indent: 0, color: "default" },
  { id: "workflow-input", order: 2, indent: 1, color: "group:main" },
  { id: "workflow-output", order: 3, indent: 1, color: "group:main" },
];

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createWorkflowResponse(workflowName) {
  const bundle = deepClone(sampleBundle);
  bundle.workflow.workflowId = workflowName;
  bundle.workflow.description = "New workflow";
  bundle.nodePayloads["oyakata-manager"].variables.workflowId = workflowName;
  bundle.nodePayloads["main-oyakata"].variables.workflowId = workflowName;

  return {
    workflowName,
    workflowDirectory: `/virtual/workflows/${workflowName}`,
    revision: `sha256:${workflowName}-rev-1`,
    bundle,
    derivedVisualization: deepClone(sampleDerivedVisualization),
  };
}

function createSessionDetail(workflowName, workflowExecutionId) {
  return {
    workflowExecutionId,
    sessionId: workflowExecutionId,
    workflowName,
    workflowId: workflowName,
    status: "paused",
    startedAt: "2026-03-09T10:00:00.000Z",
    endedAt: undefined,
    queue: ["workflow-output"],
    currentNodeId: "workflow-output",
    nodeExecutionCounter: 1,
    nodeExecutionCounts: {
      "oyakata-manager": 1,
    },
    loopIterationCounts: {},
    restartCounts: {},
    restartEvents: [],
    transitions: [
      { from: "workflow-input", to: "workflow-output", when: "always" },
    ],
    nodeExecutions: [
      {
        nodeId: "oyakata-manager",
        nodeExecId: `${workflowExecutionId}-node-1`,
        status: "succeeded",
        artifactDir: `/virtual/artifacts/${workflowExecutionId}/oyakata-manager/1`,
        startedAt: "2026-03-09T10:00:00.000Z",
        endedAt: "2026-03-09T10:00:02.000Z",
      },
    ],
    communicationCounter: 0,
    communications: [],
    conversationTurns: [],
    nodeBackendSessions: {},
    runtimeVariables: {
      workflowName,
      topic: "demo",
    },
  };
}

function createAbsoluteBuiltAssetUrl(assetPath) {
  const relativeAssetPath = assetPath.startsWith("/")
    ? assetPath.slice(1)
    : assetPath;
  return pathToFileURL(
    path.join(process.cwd(), "ui", "dist", relativeAssetPath),
  ).href;
}

async function detectFrontendModeFromEntrypoints() {
  const { detectUiFramework, frontendModeFromUiFramework } = await import(
    "../scripts/ui-framework.mjs"
  );
  return frontendModeFromUiFramework(detectUiFramework());
}

function renderHarnessHtml(assetUrls, frontendMode) {
  const stylesheetTags = assetUrls.stylesheetUrls
    .map(
      (stylesheetUrl) =>
        `    <link rel="stylesheet" href="${stylesheetUrl}" />`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>oyakata UI harness</title>
${stylesheetTags}
    <script>
      (() => {
        const nativeFetch = window.fetch.bind(window);
        const state = {
          config: {
            fixedWorkflowName: null,
            readOnly: false,
            noExec: false,
            frontend: "${frontendMode}",
          },
          workflows: [],
          workflowResponses: {},
          sessions: [],
          sessionDetails: {},
          nextSessionCounter: 1,
        };

        function jsonResponse(payload, status = 200) {
          return new Response(JSON.stringify(payload, null, 2), {
            status,
            headers: {
              "content-type": "application/json; charset=utf-8",
            },
          });
        }

        function clone(value) {
          return structuredClone(value);
        }

        function createWorkflowResponse(workflowName) {
          const response = ${JSON.stringify(createWorkflowResponse("browser-demo"))};
          response.workflowName = workflowName;
          response.workflowDirectory = "/virtual/workflows/" + workflowName;
          response.revision = "sha256:" + workflowName + "-rev-1";
          response.bundle.workflow.workflowId = workflowName;
          response.bundle.workflow.description = "New workflow";
          response.bundle.nodePayloads["oyakata-manager"].variables.workflowId = workflowName;
          response.bundle.nodePayloads["main-oyakata"].variables.workflowId = workflowName;
          return response;
        }

        function sessionSummaryFromDetail(detail) {
          return {
            workflowExecutionId: detail.workflowExecutionId,
            sessionId: detail.sessionId,
            workflowName: detail.workflowName,
            status: detail.status,
            currentNodeId: detail.currentNodeId ?? null,
            nodeExecutionCounter: detail.nodeExecutionCounter,
            startedAt: detail.startedAt,
            endedAt: detail.endedAt ?? null,
          };
        }

        function createSessionDetail(workflowName, workflowExecutionId) {
          const detail = ${JSON.stringify(createSessionDetail("browser-demo", "sess-20260309T100000Z-demo01"))};
          detail.workflowName = workflowName;
          detail.workflowId = workflowName;
          detail.workflowExecutionId = workflowExecutionId;
          detail.sessionId = workflowExecutionId;
          detail.runtimeVariables.workflowName = workflowName;
          detail.nodeExecutions[0].nodeExecId = workflowExecutionId + "-node-1";
          detail.nodeExecutions[0].artifactDir = "/virtual/artifacts/" + workflowExecutionId + "/oyakata-manager/1";
          return detail;
        }

        window.fetch = async (input, init = {}) => {
          const rawUrl =
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : String(input);
          const method =
            init.method ??
            (input instanceof Request ? input.method : "GET");
          const url = rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl.startsWith("file://")
            ? new URL(rawUrl)
            : new URL(rawUrl, "http://oyakata.local");
          const pathname = url.pathname;

          if (!pathname.startsWith("/api/")) {
            return nativeFetch(input, init);
          }

          if (pathname === "/api/ui-config" && method === "GET") {
            return jsonResponse(clone(state.config));
          }

          if (pathname === "/api/workflows" && method === "GET") {
            return jsonResponse({ workflows: [...state.workflows] });
          }

          if (pathname === "/api/workflows" && method === "POST") {
            const body = JSON.parse(init.body ?? "{}");
            const workflowName = typeof body.workflowName === "string" ? body.workflowName.trim() : "";
            const created = createWorkflowResponse(workflowName);
            state.workflows = [...state.workflows, workflowName];
            state.workflowResponses[workflowName] = created;
            return jsonResponse(clone(created), 201);
          }

          if (pathname === "/api/sessions" && method === "GET") {
            return jsonResponse({ sessions: clone(state.sessions) });
          }

          if (pathname.startsWith("/api/workflows/")) {
            const suffix = pathname.slice("/api/workflows/".length);
            const [encodedWorkflowName, tail = ""] = suffix.split("/", 2);
            const workflowName = decodeURIComponent(encodedWorkflowName);
            const current = state.workflowResponses[workflowName];

            if (tail === "" && method === "GET") {
              return jsonResponse(clone(current));
            }

            if (tail === "" && method === "PUT") {
              const body = JSON.parse(init.body ?? "{}");
              const nextBundle = clone(body.bundle);
              const revisionNumber = Number(String(current.revision).split("-rev-")[1] ?? "1") + 1;
              const updated = {
                ...current,
                revision: "sha256:" + workflowName + "-rev-" + String(revisionNumber),
                bundle: nextBundle,
              };
              state.workflowResponses[workflowName] = updated;
              return jsonResponse({
                workflowName,
                workflowDirectory: updated.workflowDirectory,
                revision: updated.revision,
              });
            }

            if (tail === "validate" && method === "POST") {
              return jsonResponse({ valid: true, warnings: [] });
            }

            if (tail === "execute" && method === "POST") {
              const workflowExecutionId =
                "sess-20260309T100000Z-" + String(state.nextSessionCounter).padStart(2, "0");
              state.nextSessionCounter += 1;
              const detail = createSessionDetail(workflowName, workflowExecutionId);
              state.sessionDetails[workflowExecutionId] = detail;
              state.sessions = [sessionSummaryFromDetail(detail), ...state.sessions];
              return jsonResponse({
                accepted: true,
                workflowExecutionId,
                sessionId: workflowExecutionId,
                status: "running",
              });
            }
          }

          if (pathname.startsWith("/api/workflow-executions/")) {
            const suffix = pathname.slice("/api/workflow-executions/".length);
            const [encodedWorkflowExecutionId, tail = ""] = suffix.split("/", 2);
            const workflowExecutionId = decodeURIComponent(encodedWorkflowExecutionId);
            const current = state.sessionDetails[workflowExecutionId];

            if (tail === "" && method === "GET") {
              return jsonResponse(clone(current));
            }

            if (tail === "cancel" && method === "POST") {
              current.status = "cancelled";
              current.endedAt = "2026-03-09T10:05:00.000Z";
              state.sessions = state.sessions.map((session) =>
                session.workflowExecutionId === workflowExecutionId
                  ? {
                      ...session,
                      status: "cancelled",
                      endedAt: current.endedAt,
                    }
                  : session,
              );
              return jsonResponse({
                accepted: true,
                workflowExecutionId,
                sessionId: workflowExecutionId,
                status: "cancelled",
              });
            }
          }

          throw new Error("Unhandled harness fetch: " + method + " " + rawUrl);
        };
      })();
    </script>
    <script type="module" src="${assetUrls.moduleScriptUrl}"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`;
}

test("runs browser workflow editor flow against the built UI with a file-backed mock API", async ({
  page,
}) => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "oyakata-ui-file-harness-"),
  );

  try {
    const { parseBuiltIndexAssets } = await import(
      "../scripts/ui-built-assets.mjs"
    );
    const builtIndexHtml = await readFile(
      path.join(process.cwd(), "ui", "dist", "index.html"),
      "utf8",
    );
    const assetUrls = parseBuiltIndexAssets(
      builtIndexHtml,
      createAbsoluteBuiltAssetUrl,
    );
    const frontendMode = await detectFrontendModeFromEntrypoints();
    const harnessPath = path.join(tempRoot, "index.html");
    await writeFile(
      harnessPath,
      renderHarnessHtml(assetUrls, frontendMode),
      "utf8",
    );

    await page.goto(pathToFileURL(harnessPath).href);

    await expect(
      page.getByRole("heading", { name: "oyakata Workflow Editor" }),
    ).toBeVisible();

    await page.getByLabel("Create Workflow").fill("browser-demo");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByLabel("Select Workflow")).toHaveValue(
      "browser-demo",
    );
    await expect(page.locator(".message.info")).toContainText(
      "Created workflow 'browser-demo'.",
    );

    await page
      .getByLabel("Workflow Description")
      .fill("Workflow created through file-backed browser regression");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".message.info")).toContainText(
      "Saved workflow 'browser-demo' at revision",
    );

    await page
      .getByLabel("Mock Scenario JSON")
      .fill(
        '{"oyakata-manager":{"provider":"scenario-mock","when":{"always":true},"payload":{"stage":"design"}}}',
      );
    await page.getByLabel("Max Steps").fill("1");
    await page.getByRole("button", { name: "Run Workflow" }).click();

    await expect(page.locator(".message.info")).toContainText(
      "Execution accepted for 'browser-demo' as execution sess-",
    );
    await expect(page.locator(".sessions")).toContainText("sess-");
    await expect(page.locator(".session-detail")).toContainText("Execution ID");
    await expect(page.locator(".session-detail")).toContainText("Session ID");
    await expect(page.locator(".session-detail")).toContainText("paused");
    await expect(page.locator(".session-detail")).toContainText(
      '"workflowName": "browser-demo"',
    );
    await expect(page.locator(".execution-history")).toContainText(
      "oyakata-manager",
    );

    await page.getByRole("button", { name: "Cancel Selected" }).click();
    await expect(page.locator(".message.info")).toContainText(
      "Cancelled execution sess-",
    );
    await expect(page.locator(".session-detail")).toContainText("cancelled");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
