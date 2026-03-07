import { describe, expect, test } from "bun:test";
import { startServe } from "./serve";

describe("startServe", () => {
  test("allocates a concrete port when port 0 is requested", async () => {
    let capturedPort = -1;

    const started = await startServe(
      {
        host: "127.0.0.1",
        port: 0,
      },
      {
        allocatePort: async () => 48321,
        serve: ({ port }) => {
          capturedPort = port;
          return {
            port,
            stop: () => {},
          };
        },
      },
    );

    expect(capturedPort).toBe(48321);
    expect(started.port).toBe(48321);
  });

  test("reports the actual bound port from the server", async () => {
    const started = await startServe(
      {
        host: "127.0.0.1",
        port: 41000,
      },
      {
        allocatePort: async () => 49999,
        serve: () => ({
          port: 41001,
          stop: () => {},
        }),
      },
    );

    expect(started.port).toBe(41001);
  });

  test("rejects negative ports", async () => {
    await expect(
      startServe(
        {
          host: "127.0.0.1",
          port: -1,
        },
        {
          allocatePort: async () => 48321,
          serve: ({ port }) => ({
            port,
            stop: () => {},
          }),
        },
      ),
    ).rejects.toThrow("invalid serve port '-1'");
  });
});
