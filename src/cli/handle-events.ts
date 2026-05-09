import {
  createEventListenerService,
  loadAndValidateEventConfiguration,
} from "../events";
import { emitEventFile } from "../events/manual-emit";
import { listEventReceipts, replayEventReceipt } from "../events/receipt-ops";
import { listEventReplyDispatchesFromRuntimeDb } from "../workflow/runtime-db";
import { emitJson, formatValidationIssues } from "./helpers";
import { parseEnvBooleanFlag, parseReplyDispatchStatus } from "./arg-parser";
import { readMockScenarioOption } from "./io-helpers";
import type { CliHandlerContext } from "./types";

export async function handleEventsScope(
  ctx: CliHandlerContext,
): Promise<number> {
  const {
    io,
    deps,
    parsed,
    command,
    target,
    sharedOptions,
    graphqlCliTransport,
    env,
  } = ctx;

  const eventsReadOnly =
    parsed.options.readOnly ||
    parseEnvBooleanFlag(env["DIVEDRA_EVENTS_READ_ONLY"]);
  let mockScenarioOptions: Readonly<{
    mockScenario?: import("../workflow/adapter").MockNodeScenario;
  }> = {};
  if (parsed.options.mockScenarioPath !== undefined) {
    if (parsed.options.endpoint !== undefined) {
      io.stderr("--mock-scenario cannot be combined with --endpoint");
      return 2;
    }
    try {
      mockScenarioOptions = await readMockScenarioOption(
        parsed.options.mockScenarioPath,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`failed to read mock scenario: ${message}`);
      return 2;
    }
  }
  const eventOptions = {
    ...sharedOptions,
    ...mockScenarioOptions,
    ...(parsed.options.dryRun ? { dryRun: true } : {}),
    ...(parsed.options.maxSteps === undefined
      ? {}
      : { maxSteps: parsed.options.maxSteps }),
    ...(parsed.options.maxLoopIterations === undefined
      ? {}
      : { maxLoopIterations: parsed.options.maxLoopIterations }),
    ...(parsed.options.defaultTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: parsed.options.defaultTimeoutMs }),
    ...(parsed.options.eventRoot === undefined
      ? {}
      : { eventRoot: parsed.options.eventRoot }),
    ...(parsed.options.endpoint === undefined
      ? {}
      : { endpoint: parsed.options.endpoint }),
    ...(graphqlCliTransport?.authToken === undefined
      ? {}
      : { authToken: graphqlCliTransport.authToken }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(eventsReadOnly ? { readOnly: true } : {}),
  };

  if (command === "validate") {
    try {
      const result = await loadAndValidateEventConfiguration(eventOptions);
      if (parsed.options.output === "json") {
        emitJson(io, {
          valid: result.valid,
          eventRoot: result.configuration.eventRoot,
          sources: result.configuration.sources.length,
          bindings: result.configuration.bindings.length,
          issues: result.issues,
        });
      } else if (result.valid) {
        io.stdout(
          `event configuration is valid: ${result.configuration.eventRoot}`,
        );
      } else {
        io.stderr("event validation failed");
        io.stderr(formatValidationIssues(result.issues));
      }
      return result.valid ? 0 : 2;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`events validate failed: ${message}`);
      return 1;
    }
  }

  if (command === "emit") {
    const sourceId = target;
    const eventFile = parsed.options.eventFile ?? parsed.options.filePath;
    if (sourceId === undefined || eventFile === undefined) {
      io.stderr("source id and --event-file are required");
      io.stderr(
        "usage: divedra events emit <source-id> --event-file <path> [options]",
      );
      return 2;
    }
    try {
      const results = await emitEventFile({
        ...eventOptions,
        sourceId,
        eventFile,
      });
      if (parsed.options.output === "json") {
        emitJson(io, {
          sourceId,
          receipts: results.map((result) => ({
            receiptId: result.receipt.receiptId,
            status: result.receipt.status,
            duplicate: result.duplicate,
            workflowName: result.workflowName ?? null,
            workflowExecutionId: result.workflowExecutionId ?? null,
          })),
        });
      } else {
        for (const result of results) {
          io.stdout(
            [
              `receipt: ${result.receipt.receiptId}`,
              `status: ${result.receipt.status}`,
              `duplicate: ${String(result.duplicate)}`,
              `workflowExecutionId: ${result.workflowExecutionId ?? "-"}`,
            ].join(" "),
          );
        }
      }
      return results.some((result) => result.receipt.status === "failed")
        ? 1
        : 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`events emit failed: ${message}`);
      return 1;
    }
  }

  if (command === "list") {
    try {
      const receipts = await listEventReceipts({
        ...eventOptions,
        ...(parsed.options.sourceId === undefined
          ? {}
          : { sourceId: parsed.options.sourceId }),
        ...(parsed.options.status === undefined
          ? {}
          : { status: parsed.options.status }),
        ...(parsed.options.limit === undefined
          ? {}
          : { limit: parsed.options.limit }),
      });
      if (parsed.options.output === "json") {
        emitJson(io, { receipts });
      } else {
        for (const receipt of receipts) {
          io.stdout(
            [
              `receipt: ${receipt.receiptId}`,
              `source: ${receipt.sourceId}`,
              `binding: ${receipt.bindingId ?? "-"}`,
              `status: ${receipt.status}`,
              `workflowExecutionId: ${receipt.workflowExecutionId ?? "-"}`,
              `updatedAt: ${receipt.updatedAt}`,
            ].join(" "),
          );
        }
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`events list failed: ${message}`);
      return 1;
    }
  }

  if (command === "replies") {
    const status = parseReplyDispatchStatus(parsed.options.status);
    if (parsed.options.status !== undefined && status === undefined) {
      io.stderr("--status must be one of dispatching, sent, queued, or failed");
      return 2;
    }
    try {
      const replies = await listEventReplyDispatchesFromRuntimeDb(
        {
          ...(target === undefined ? {} : { workflowExecutionId: target }),
          ...(status === undefined ? {} : { status }),
          ...(parsed.options.limit === undefined
            ? {}
            : { limit: parsed.options.limit }),
        },
        eventOptions,
      );
      if (parsed.options.output === "json") {
        emitJson(io, { replies });
      } else {
        for (const reply of replies) {
          io.stdout(
            [
              `reply: ${reply.idempotencyKey}`,
              `source: ${reply.sourceId}`,
              `status: ${reply.status}`,
              `workflowExecutionId: ${reply.workflowExecutionId}`,
              `node: ${reply.nodeId}/${reply.nodeExecId}`,
              `providerMessageId: ${reply.providerMessageId ?? "-"}`,
              `updatedAt: ${reply.updatedAt}`,
            ].join(" "),
          );
        }
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`events replies failed: ${message}`);
      return 1;
    }
  }

  if (command === "replay") {
    const receiptId = target;
    if (receiptId === undefined) {
      io.stderr("receipt id is required");
      io.stderr(
        "usage: divedra events replay <receipt-id> [--reason <text>] [--dry-run] [options]",
      );
      return 2;
    }
    try {
      const result = await replayEventReceipt({
        ...eventOptions,
        receiptId,
        ...(parsed.options.reason === undefined
          ? {}
          : { reason: parsed.options.reason }),
      });
      if (parsed.options.output === "json") {
        emitJson(io, {
          replayedFromReceiptId: result.original.receiptId,
          replayEventId: result.replayEvent.eventId,
          replayReason: result.reason ?? null,
          receipts: result.receipts.map((entry) => ({
            receiptId: entry.receipt.receiptId,
            status: entry.receipt.status,
            duplicate: entry.duplicate,
            workflowName: entry.workflowName ?? null,
            workflowExecutionId: entry.workflowExecutionId ?? null,
          })),
        });
      } else {
        for (const entry of result.receipts) {
          io.stdout(
            [
              `replayedFrom: ${result.original.receiptId}`,
              `receipt: ${entry.receipt.receiptId}`,
              `status: ${entry.receipt.status}`,
              `duplicate: ${String(entry.duplicate)}`,
              `reason: ${result.reason ?? "-"}`,
              `workflowExecutionId: ${entry.workflowExecutionId ?? "-"}`,
            ].join(" "),
          );
        }
      }
      return result.receipts.some((entry) => entry.receipt.status === "failed")
        ? 1
        : 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`events replay failed: ${message}`);
      return 1;
    }
  }

  if (command === "serve") {
    try {
      const listener = await createEventListenerService().start({
        ...eventOptions,
        ...(parsed.options.host === undefined
          ? {}
          : { host: parsed.options.host }),
        ...(parsed.options.port === undefined
          ? {}
          : { port: parsed.options.port }),
      });
      if (parsed.options.output === "json") {
        emitJson(io, {
          host: listener.host ?? null,
          port: listener.port ?? null,
          sources: listener.sources,
        });
      } else {
        io.stdout(
          listener.host === undefined || listener.port === undefined
            ? `events listening for sources: ${listener.sources.join(",") || "-"}`
            : `events listening on http://${listener.host}:${String(listener.port)}`,
        );
      }
      const waitForEventListenerShutdown = deps.waitForEventListenerShutdown;
      try {
        if (waitForEventListenerShutdown !== undefined) {
          await waitForEventListenerShutdown(listener);
        }
      } finally {
        await listener.stop();
      }
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      io.stderr(`events serve failed: ${message}`);
      return 7;
    }
  }

  io.stderr(`unknown events command: ${command ?? "(empty)"}`);
  return 2;
}
