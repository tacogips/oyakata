import { For, Show, type JSX } from "solid-js";

import type {
  UiConfigResponse,
  WorkflowExecutionStateResponse,
  WorkflowExecutionSummary,
} from "../../../../src/shared/ui-contract";
import {
  canCancelWorkflowExecution,
  sessionStatusClass,
} from "../editor-support";
import { Badge, Button } from "./ui";

type AsyncAction = () => void | Promise<void>;
type SelectSessionAction = (
  workflowExecutionId: string,
) => void | Promise<void>;

export interface ExecutionPanelProps {
  readonly selectedWorkflowName: string;
  readonly config: UiConfigResponse | null;
  readonly busy: boolean;
  readonly runtimeVariablesText: string;
  readonly mockScenarioText: string;
  readonly maxStepsText: string;
  readonly maxLoopIterationsText: string;
  readonly defaultTimeoutText: string;
  readonly runAsync: boolean;
  readonly runDryRun: boolean;
  readonly sessions: readonly WorkflowExecutionSummary[];
  readonly selectedExecutionId: string;
  readonly selectedSession: WorkflowExecutionStateResponse | null;
  readonly onRuntimeVariablesTextChange: (value: string) => void;
  readonly onMockScenarioTextChange: (value: string) => void;
  readonly onMaxStepsTextChange: (value: string) => void;
  readonly onMaxLoopIterationsTextChange: (value: string) => void;
  readonly onDefaultTimeoutTextChange: (value: string) => void;
  readonly onRunAsyncChange: (value: boolean) => void;
  readonly onRunDryRunChange: (value: boolean) => void;
  readonly onExecuteWorkflow: AsyncAction;
  readonly onCancelSelectedSession: AsyncAction;
  readonly onSelectSession: SelectSessionAction;
}

export default function ExecutionPanel(
  props: ExecutionPanelProps,
): JSX.Element {
  const executionDisabled = (): boolean =>
    props.config?.noExec === true || props.busy;

  return (
    <section class="panel side-panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Runtime</p>
          <h2>Execution</h2>
        </div>
        <Badge variant="outline">{props.sessions.length} sessions</Badge>
      </div>
      <Show
        when={props.selectedWorkflowName.length > 0}
        fallback={
          <p class="empty">Choose a workflow to run or inspect sessions.</p>
        }
      >
        <div class="execution-form">
          <label for="runtime-variables">Runtime Variables JSON</label>
          <textarea
            id="runtime-variables"
            class="code compact"
            value={props.runtimeVariablesText}
            spellcheck={false}
            disabled={executionDisabled()}
            onInput={(event) => {
              props.onRuntimeVariablesTextChange(event.currentTarget.value);
            }}
          />

          <label for="mock-scenario">Mock Scenario JSON</label>
          <textarea
            id="mock-scenario"
            class="code compact"
            value={props.mockScenarioText}
            placeholder='{"node-id":{"provider":"scenario-mock","when":{"always":true},"payload":{"stage":"demo"}}}'
            spellcheck={false}
            disabled={executionDisabled()}
            onInput={(event) => {
              props.onMockScenarioTextChange(event.currentTarget.value);
            }}
          />

          <div class="property-grid execution-grid">
            <div>
              <label for="max-steps">Max Steps</label>
              <input
                id="max-steps"
                value={props.maxStepsText}
                placeholder="optional"
                disabled={executionDisabled()}
                onInput={(event) => {
                  props.onMaxStepsTextChange(event.currentTarget.value);
                }}
              />
            </div>
            <div>
              <label for="max-loop">Max Loop Iterations</label>
              <input
                id="max-loop"
                value={props.maxLoopIterationsText}
                placeholder="optional"
                disabled={executionDisabled()}
                onInput={(event) => {
                  props.onMaxLoopIterationsTextChange(
                    event.currentTarget.value,
                  );
                }}
              />
            </div>
            <div>
              <label for="run-timeout">Default Timeout (ms)</label>
              <input
                id="run-timeout"
                value={props.defaultTimeoutText}
                placeholder="optional"
                disabled={executionDisabled()}
                onInput={(event) => {
                  props.onDefaultTimeoutTextChange(event.currentTarget.value);
                }}
              />
            </div>
          </div>

          <label class="toggle">
            <input
              type="checkbox"
              checked={props.runAsync}
              disabled={executionDisabled()}
              onChange={(event) => {
                props.onRunAsyncChange(event.currentTarget.checked);
              }}
            />
            <span>Run asynchronously and poll selected session</span>
          </label>

          <label class="toggle">
            <input
              type="checkbox"
              checked={props.runDryRun}
              disabled={executionDisabled()}
              onChange={(event) => {
                props.onRunDryRunChange(event.currentTarget.checked);
              }}
            />
            <span>Dry run</span>
          </label>

          <div class="toolbar-grid single-row">
            <Button
              variant="secondary"
              type="button"
              disabled={executionDisabled()}
              onClick={() => void props.onExecuteWorkflow()}
            >
              Run Workflow
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={
                executionDisabled() ||
                !canCancelWorkflowExecution(props.selectedSession?.status)
              }
              onClick={() => void props.onCancelSelectedSession()}
            >
              Cancel Selected
            </Button>
          </div>
        </div>

        <div class="sessions">
          <div class="section-head">
            <h3>Recent Sessions</h3>
            <span>{props.sessions.length}</span>
          </div>
          <Show
            when={props.sessions.length > 0}
            fallback={
              <p class="empty">
                No sessions recorded for {props.selectedWorkflowName}.
              </p>
            }
          >
            <For each={props.sessions}>
              {(session) => (
                <button
                  class="session-card ghost"
                  classList={{
                    selected:
                      session.workflowExecutionId === props.selectedExecutionId,
                  }}
                  type="button"
                  onClick={() => {
                    void props.onSelectSession(session.workflowExecutionId);
                  }}
                >
                  <div class="session-head">
                    <strong class={sessionStatusClass(session.status)}>
                      {session.status}
                    </strong>
                    <span>{session.currentNodeId ?? "no active node"}</span>
                  </div>
                  <div class="session-meta">{session.sessionId}</div>
                  <div class="session-meta">
                    Executions: {session.nodeExecutionCounter}
                  </div>
                  <div class="session-meta">Started: {session.startedAt}</div>
                </button>
              )}
            </For>
          </Show>
        </div>

        <div class="session-detail">
          <div class="section-head">
            <h3>Selected Session</h3>
            <Show when={props.selectedSession}>
              {(selectedSession) => (
                <span
                  class={`badge ${sessionStatusClass(selectedSession().status)}`}
                >
                  {selectedSession().status}
                </span>
              )}
            </Show>
          </div>

          <Show
            when={props.selectedSession}
            fallback={
              <p class="empty">
                Select a session to inspect status, queue, and node execution
                history.
              </p>
            }
          >
            {(selectedSession) => (
              <div class="editor-column">
                <div class="detail-grid">
                  <div>
                    <span class="detail-label">Execution ID</span>
                    <code>{selectedSession().workflowExecutionId}</code>
                  </div>
                  <div>
                    <span class="detail-label">Session ID</span>
                    <code>{selectedSession().sessionId}</code>
                  </div>
                  <div>
                    <span class="detail-label">Current Node</span>
                    <code>{selectedSession().currentNodeId ?? "-"}</code>
                  </div>
                  <div>
                    <span class="detail-label">Queue</span>
                    <code>
                      {selectedSession().queue.length > 0
                        ? selectedSession().queue.join(", ")
                        : "-"}
                    </code>
                  </div>
                  <div>
                    <span class="detail-label">Transitions</span>
                    <code>{selectedSession().transitions.length}</code>
                  </div>
                </div>

                <Show when={selectedSession().lastError}>
                  {(lastError) => (
                    <p class="message error compact-message">{lastError()}</p>
                  )}
                </Show>

                <div>
                  <p class="detail-label">Runtime Variables</p>
                  <pre>
                    {JSON.stringify(
                      selectedSession().runtimeVariables,
                      null,
                      2,
                    )}
                  </pre>
                </div>

                <div class="execution-history">
                  <div class="section-head">
                    <h3>Node Executions</h3>
                    <span>{selectedSession().nodeExecutions.length}</span>
                  </div>
                  <Show
                    when={selectedSession().nodeExecutions.length > 0}
                    fallback={
                      <p class="empty">No node executions recorded yet.</p>
                    }
                  >
                    <For each={[...selectedSession().nodeExecutions].reverse()}>
                      {(execution) => (
                        <article class="history-card">
                          <div class="session-head">
                            <strong>{execution.nodeId}</strong>
                            <span class={execution.status}>
                              {execution.status}
                            </span>
                          </div>
                          <div class="session-meta">{execution.nodeExecId}</div>
                          <div class="session-meta">
                            Started: {execution.startedAt}
                          </div>
                          <div class="session-meta">
                            Ended: {execution.endedAt}
                          </div>
                        </article>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
