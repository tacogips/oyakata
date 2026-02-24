import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createSessionState } from "./session";
import { loadSession, saveSession } from "./session-store";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-session-store-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("session-store", () => {
  test("save/load roundtrip", async () => {
    const root = await makeTempDir();
    const session = createSessionState({
      sessionId: "sess-abc12345",
      workflowName: "wf",
      workflowId: "wf",
      initialNodeId: "manager",
      runtimeVariables: { topic: "demo" },
    });

    const save = await saveSession(session, { sessionStoreRoot: root });
    expect(save.ok).toBe(true);

    const loaded = await loadSession(session.sessionId, { sessionStoreRoot: root });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.sessionId).toBe(session.sessionId);
    expect(loaded.value.queue[0]).toBe("manager");
  });

  test("rejects invalid session id", async () => {
    const root = await makeTempDir();
    const loaded = await loadSession("../bad", { sessionStoreRoot: root });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe("INVALID_SESSION_ID");
    }
  });
});
