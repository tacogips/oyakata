import { loadWorkflowByIdFromDisk } from "./load";
import {
  buildSuperviserRuntimeControl,
  workflowRunBaseForSuperviserControl,
} from "./superviser-runtime-control-impl";
import type { NodeAdapter } from "./adapter";
import { loadSession, saveSession } from "./session-store";
import { createSessionId } from "./session";
import type { WorkflowSessionState } from "./session";
import type { LoadedWorkflow } from "./load";
import {
  err,
  ok,
  workflowRunFailure,
  type EngineExecutionGuards,
  type RunWorkflowInternalFn,
  type RunWorkflowFn,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./engine-types";
import type { Result } from "./result";
import type { SupervisionRunState } from "./types";

export async function runNestedSuperviserSessionDriver(
  workflowName: string,
  session: WorkflowSessionState,
  loaded: LoadedWorkflow,
  options: WorkflowRunOptions,
  adapter: NodeAdapter | undefined,
  guards: EngineExecutionGuards | undefined,
  crossWorkflowInvocationStack: readonly string[],
  runWorkflowInternalFn: RunWorkflowInternalFn,
  runWorkflowFn: RunWorkflowFn,
): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> {
  const sup = session.supervision;
  if (sup === undefined || options.autoImprove === undefined) {
    return err(
      workflowRunFailure(
        2,
        "internal: nested superviser requires supervision and policy",
      ),
    );
  }
  const supLoad = await loadWorkflowByIdFromDisk(
    sup.superviserWorkflowId,
    options,
  );
  if (!supLoad.ok) {
    return err(
      workflowRunFailure(
        2,
        `nested superviser: load '${sup.superviserWorkflowId}': ${supLoad.error.message}`,
        session,
      ),
    );
  }
  const resumingTarget =
    options.resumeSessionId !== undefined &&
    options.resumeSessionId === session.sessionId;
  const existingSuperviserRunSessionId = sup.nestedSuperviserSessionId;
  let sessionWithSuperviserRunId: WorkflowSessionState;
  let superviserRunSessionId: string;
  let resumeSuperviserRunSession: boolean;
  if (resumingTarget) {
    if (existingSuperviserRunSessionId === undefined) {
      return err(
        workflowRunFailure(
          2,
          "internal: nested superviser resume requires nestedSuperviserSessionId on supervision",
          session,
        ),
      );
    }
    const superviserRunLoaded = await loadSession(
      existingSuperviserRunSessionId,
      options,
    );
    if (!superviserRunLoaded.ok) {
      return err(
        workflowRunFailure(
          1,
          `nested superviser: load session for superviser run: ${superviserRunLoaded.error.message}`,
          session,
        ),
      );
    }
    const superviserRunCompleted =
      superviserRunLoaded.value.status === "completed";
    const targetStillActive = session.status !== "completed";
    if (superviserRunCompleted && targetStillActive) {
      superviserRunSessionId = createSessionId({
        workflowId: supLoad.value.bundle.workflow.workflowId,
      });
      sessionWithSuperviserRunId = {
        ...session,
        supervision: {
          ...sup,
          nestedSuperviserSessionId: superviserRunSessionId,
        },
      };
      const savedSuperviser = await saveSession(
        sessionWithSuperviserRunId,
        options,
      );
      if (!savedSuperviser.ok) {
        return err(
          workflowRunFailure(
            1,
            savedSuperviser.error.message,
            sessionWithSuperviserRunId,
          ),
        );
      }
      resumeSuperviserRunSession = false;
    } else {
      superviserRunSessionId = existingSuperviserRunSessionId;
      sessionWithSuperviserRunId = session;
      resumeSuperviserRunSession = true;
    }
  } else {
    superviserRunSessionId = createSessionId({
      workflowId: supLoad.value.bundle.workflow.workflowId,
    });
    sessionWithSuperviserRunId = {
      ...session,
      supervision: {
        ...sup,
        nestedSuperviserSessionId: superviserRunSessionId,
      },
    };
    const savedSuperviser = await saveSession(
      sessionWithSuperviserRunId,
      options,
    );
    if (!savedSuperviser.ok) {
      return err(
        workflowRunFailure(
          1,
          savedSuperviser.error.message,
          sessionWithSuperviserRunId,
        ),
      );
    }
    resumeSuperviserRunSession = false;
  }
  const baseForControl = workflowRunBaseForSuperviserControl(options);
  const runWorkflowWithAdapter = (
    name: string,
    opts: WorkflowRunOptions,
  ): Promise<Result<WorkflowRunResult, WorkflowRunFailure>> =>
    runWorkflowFn(name, opts, adapter, guards);
  const control = buildSuperviserRuntimeControl({
    base: baseForControl,
    runWorkflow: runWorkflowWithAdapter,
    auth: {
      supervisionRunId: sup.supervisionRunId,
      targetSessionId: session.sessionId,
    },
    targetWorkflowName: workflowName,
    targetExpectedWorkflowId: loaded.bundle.workflow.workflowId,
    defaultPolicy: options.autoImprove,
  });
  const {
    autoImprove: _ai2,
    supervisionLoopExecution: _sl2,
    nestedSuperviserDriver: _nd2,
    superviserControl: _sc2,
    ...supOptsBase
  } = baseForControl;
  const baseRv = supOptsBase.runtimeVariables ?? {};
  const supOpts: WorkflowRunOptions = {
    ...supOptsBase,
    runtimeVariables: {
      ...baseRv,
      supervisionRunId: sup.supervisionRunId,
      targetSessionId: session.sessionId,
      superviserTargetWorkflowId: loaded.bundle.workflow.workflowId,
    },
    superviserControl: control,
    ...(resumeSuperviserRunSession
      ? { resumeSessionId: superviserRunSessionId }
      : { sessionId: superviserRunSessionId }),
  };
  const supResult = await runWorkflowInternalFn(
    supLoad.value.workflowName,
    supOpts,
    adapter,
    guards,
    crossWorkflowInvocationStack,
  );
  const reloaded = await loadSession(session.sessionId, options);
  const target =
    reloaded.ok && reloaded.value.supervision !== undefined
      ? reloaded.value
      : sessionWithSuperviserRunId;
  if (supResult.ok) {
    const exit = supResult.value.exitCode;
    const st: SupervisionRunState["status"] =
      exit === 0 ? "succeeded" : exit === 4 ? "stopped" : "failed";
    const nextSup: SupervisionRunState = {
      ...(target.supervision as SupervisionRunState),
      status: st,
    };
    const stamped: WorkflowSessionState = {
      ...target,
      supervision: nextSup,
    };
    const w = await saveSession(stamped, options);
    if (!w.ok) {
      return err(workflowRunFailure(1, w.error.message, stamped));
    }
    return ok({ session: stamped, exitCode: exit });
  }
  const nextSup: SupervisionRunState = {
    ...((target.supervision ?? sup) as SupervisionRunState),
    status: "failed",
  };
  const stamped: WorkflowSessionState = {
    ...target,
    supervision: nextSup,
  };
  const w = await saveSession(stamped, options);
  if (!w.ok) {
    return err(workflowRunFailure(1, w.error.message, stamped));
  }
  return err(
    workflowRunFailure(
      supResult.error.exitCode,
      supResult.error.message,
      stamped,
    ),
  );
}
