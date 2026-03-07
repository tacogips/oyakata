import net from "node:net";
import { handleApiRequest, type ApiContext } from "./api";

export interface ServeStartOptions extends ApiContext {
  readonly host?: string;
  readonly port?: number;
}

export interface StartedServe {
  readonly host: string;
  readonly port: number;
  stop(): void;
}

interface ServeRuntime {
  readonly allocatePort: (host: string) => Promise<number>;
  readonly serve: (options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    readonly port: number;
    stop(): void;
  };
}

async function allocatePort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      probe.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        if (typeof port !== "number") {
          reject(new Error("failed to resolve ephemeral port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

const DEFAULT_RUNTIME: ServeRuntime = {
  allocatePort,
  serve: (options) => Bun.serve(options),
};

export async function startServe(options: ServeStartOptions = {}, runtime: ServeRuntime = DEFAULT_RUNTIME): Promise<StartedServe> {
  const host = options.host ?? options.env?.["OYAKATA_SERVE_HOST"] ?? "127.0.0.1";
  const port = options.port ?? Number(options.env?.["OYAKATA_SERVE_PORT"] ?? "5173");

  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`invalid serve port '${String(options.port)}'`);
  }

  const requestedPort = port === 0 ? await runtime.allocatePort(host) : port;
  const server = runtime.serve({
    hostname: host,
    port: requestedPort,
    fetch: (request: Request) => handleApiRequest(request, options),
  });

  return {
    host,
    port: server.port,
    stop: () => {
      server.stop();
    },
  };
}
