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

export async function startServe(options: ServeStartOptions = {}): Promise<StartedServe> {
  const host = options.host ?? options.env?.["OYAKATA_SERVE_HOST"] ?? "127.0.0.1";
  const port = options.port ?? Number(options.env?.["OYAKATA_SERVE_PORT"] ?? "5173");

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid serve port '${String(options.port)}'`);
  }

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (request: Request) => handleApiRequest(request, options),
  });

  return {
    host,
    port,
    stop: () => {
      server.stop();
    },
  };
}
