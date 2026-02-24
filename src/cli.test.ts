import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "./cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-cli-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createIoCapture(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (line: string) => void; stderr: (line: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => {
        stdout.push(line);
      },
      stderr: (line: string) => {
        stderr.push(line);
      },
    },
  };
}

describe("runCli", () => {
  test("returns help for unknown scope", async () => {
    const capture = createIoCapture();
    const code = await runCli(["unknown", "cmd", "target"], capture.io);
    expect(code).toBe(1);
    expect(capture.stdout.join("\n")).toContain("Usage:");
  });

  test("create -> validate -> inspect roundtrip", async () => {
    const root = await makeTempDir();

    const createCapture = createIoCapture();
    const createCode = await runCli(["workflow", "create", "demo", "--workflow-root", root], createCapture.io);
    expect(createCode).toBe(0);

    const validateCapture = createIoCapture();
    const validateCode = await runCli(["workflow", "validate", "demo", "--workflow-root", root], validateCapture.io);
    expect(validateCode).toBe(0);
    expect(validateCapture.stdout.join("\n")).toContain("is valid");

    const inspectCapture = createIoCapture();
    const inspectCode = await runCli(
      ["workflow", "inspect", "demo", "--workflow-root", root, "--output", "json"],
      inspectCapture.io,
    );
    expect(inspectCode).toBe(0);

    const outputJson = inspectCapture.stdout.join("\n");
    const parsed = JSON.parse(outputJson) as { workflowName: string; counts: { nodes: number } };
    expect(parsed.workflowName).toBe("demo");
    expect(parsed.counts.nodes).toBe(3);
  });

  test("run -> status -> resume flow", async () => {
    const root = await makeTempDir();
    const artifactsRoot = path.join(root, "artifacts");
    const sessionsRoot = path.join(root, "sessions");

    const createCapture = createIoCapture();
    const createCode = await runCli(["workflow", "create", "demo", "--workflow-root", root], createCapture.io);
    expect(createCode).toBe(0);

    const runCapture = createIoCapture();
    const runCode = await runCli(
      [
        "workflow",
        "run",
        "demo",
        "--workflow-root",
        root,
        "--artifact-root",
        artifactsRoot,
        "--session-store",
        sessionsRoot,
        "--max-steps",
        "1",
        "--output",
        "json",
      ],
      runCapture.io,
    );
    expect(runCode).toBe(4);

    const runPayload = JSON.parse(runCapture.stdout.join("\n")) as { sessionId: string; status: string };
    expect(runPayload.status).toBe("paused");

    const statusCapture = createIoCapture();
    const statusCode = await runCli(
      [
        "session",
        "status",
        runPayload.sessionId,
        "--workflow-root",
        root,
        "--artifact-root",
        artifactsRoot,
        "--session-store",
        sessionsRoot,
        "--output",
        "json",
      ],
      statusCapture.io,
    );
    expect(statusCode).toBe(0);
    const statusPayload = JSON.parse(statusCapture.stdout.join("\n")) as { status: string };
    expect(statusPayload.status).toBe("paused");

    const resumeCapture = createIoCapture();
    const resumeCode = await runCli(
      [
        "session",
        "resume",
        runPayload.sessionId,
        "--workflow-root",
        root,
        "--artifact-root",
        artifactsRoot,
        "--session-store",
        sessionsRoot,
      ],
      resumeCapture.io,
    );
    expect(resumeCode).toBe(0);
    expect(resumeCapture.stdout.join("\n")).toContain("completed");
  });

  test("serve command uses injected starter", async () => {
    const capture = createIoCapture();
    const started: Array<{ host?: string; port?: number; fixedWorkflowName?: string; readOnly?: boolean; noExec?: boolean }> = [];

    const code = await runCli(
      ["serve", "demo", "--host", "127.0.0.1", "--port", "7777", "--read-only", "--no-exec", "--output", "json"],
      capture.io,
      {
        startServe: async (options) => {
          started.push(options);
          return {
            host: options.host ?? "127.0.0.1",
            port: options.port ?? 7777,
            stop: () => {},
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(started).toHaveLength(1);
    expect(started[0]?.fixedWorkflowName).toBe("demo");
    expect(started[0]?.readOnly).toBe(true);
    expect(started[0]?.noExec).toBe(true);
    const payload = JSON.parse(capture.stdout.join("\n")) as { port: number };
    expect(payload.port).toBe(7777);
  });

  test("validate returns code 2 for invalid workflow name", async () => {
    const capture = createIoCapture();
    const code = await runCli(["workflow", "validate", "../bad-name"], capture.io);
    expect(code).toBe(2);
  });
});
