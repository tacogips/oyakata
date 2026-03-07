const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { expect, test } = require("@playwright/test");

const host = "127.0.0.1";

let tempRoot = "";
let currentBaseUrl = "";
let serverProcess;
let serverExited = false;
let serverLogs = "";

async function waitForHealthy(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverExited) {
      const detail = serverLogs.trim().length > 0 ? serverLogs.trim() : "server exited before /healthz became ready";
      throw new Error(detail);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error(`server did not become healthy: ${url}`);
}

async function waitForServeUrl() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverExited) {
      const detail = serverLogs.trim().length > 0 ? serverLogs.trim() : "server exited before emitting its bound URL";
      throw new Error(detail);
    }

    const stdoutLines = serverLogs
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of stdoutLines) {
      try {
        const parsed = JSON.parse(line);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.host === "string" &&
          typeof parsed.port === "number"
        ) {
          return `http://${parsed.host}:${String(parsed.port)}`;
        }
      } catch {
        // Non-JSON log lines are expected; keep scanning.
      }
    }

    await delay(250);
  }

  throw new Error(`server did not emit its bound URL: ${serverLogs.trim()}`);
}

test.beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "oyakata-e2e-"));
  const workflowRoot = path.join(tempRoot, "workflows");
  const artifactRoot = path.join(tempRoot, "artifacts");
  const sessionStoreRoot = path.join(tempRoot, "sessions");
  serverExited = false;
  serverLogs = "";

  serverProcess = spawn(
    "bun",
    [
      "run",
      "src/main.ts",
      "serve",
      "--workflow-root",
      workflowRoot,
      "--artifact-root",
      artifactRoot,
      "--session-store",
      sessionStoreRoot,
      "--host",
      host,
      "--port",
      String(process.env.OYAKATA_E2E_PORT ?? "0"),
      "--output",
      "json",
    ],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );

  serverProcess.once("exit", (code, signal) => {
    serverExited = true;
    serverLogs += `\nserver exited with ${signal === null ? `code ${String(code)}` : `signal ${signal}`}`;
  });

  serverProcess.stdout.on("data", (chunk) => {
    serverLogs += chunk.toString("utf8");
  });

  serverProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    serverLogs += text;
    if (text.trim().length > 0) {
      process.stderr.write(text);
    }
  });

  currentBaseUrl = await waitForServeUrl();
  await waitForHealthy(`${currentBaseUrl}/healthz`);
});

test.afterAll(async () => {
  if (serverProcess !== undefined && serverProcess.killed === false) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => {
      serverProcess?.once("exit", () => resolve(undefined));
      setTimeout(() => resolve(undefined), 2_000);
    });
  }

  if (tempRoot.length > 0) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("creates, edits, and executes a workflow from the browser", async ({ page }) => {
  await page.goto(`${currentBaseUrl}/`);

  await page.getByLabel("New Workflow").fill("browser-demo");
  await page.getByRole("button", { name: "Create Workflow" }).click();

  await expect(page.getByLabel("Workflow")).toHaveValue("browser-demo");
  await expect(page.locator("#editorStatus")).toContainText("Created workflow browser-demo");
  await expect(page.locator("#sessionLine")).toContainText("No session selected.");

  await page.getByLabel("Workflow Description").fill("Workflow created through browser E2E");
  await page.getByRole("button", { name: "Save Workflow" }).click();
  await expect(page.locator("#editorStatus")).toContainText("Saved revision");

  await page.getByLabel("Mock Scenario JSON (optional)").fill(
    '{"oyakata-manager":{"provider":"scenario-mock","when":{"always":true},"payload":{"stage":"design"}}}',
  );
  await page.getByLabel("Max Steps (optional pause)").fill("1");
  await page.getByRole("button", { name: "Run (Async)" }).click();

  await expect(page.locator("#sessionLine")).toContainText("sessionId=sess-", { timeout: 15_000 });
  await expect(page.locator("#sessionLine")).toContainText("status=paused", { timeout: 15_000 });
  await expect(page.locator("#sessionsList")).toContainText("sess-", { timeout: 15_000 });
  await expect(page.locator("#sessionJson")).toContainText('"workflowName": "browser-demo"');
  await expect(page.locator("#sessionJson")).toContainText('"status": "paused"');

  await expect(page.getByRole("button", { name: "Cancel Selected Session" })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel Selected Session" }).click();
  await expect(page.locator("#sessionLine")).toContainText("status=cancelled", { timeout: 15_000 });

  await page.getByLabel("New Workflow").fill("browser-demo-2");
  await page.getByRole("button", { name: "Create Workflow" }).click();
  await expect(page.getByLabel("Workflow")).toHaveValue("browser-demo-2");
  await expect(page.locator("#editorStatus")).toContainText("Created workflow browser-demo-2");
  await expect(page.locator("#sessionLine")).toContainText("No session selected.");
});
