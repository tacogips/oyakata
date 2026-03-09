<script lang="ts">
  import type {
    UiConfigResponse,
    WorkflowExecutionStateResponse,
    WorkflowExecutionSummary,
  } from "../../../../src/shared/ui-contract";
  import { canCancelWorkflowExecution, sessionStatusClass } from "../editor-support";

  type AsyncAction = () => void | Promise<void>;
  type SelectSessionAction = (workflowExecutionId: string) => void | Promise<void>;

  const noop = (): void => {};

  export let selectedWorkflowName = "";
  export let config: UiConfigResponse | null = null;
  export let busy = false;
  export let runtimeVariablesText = "{\n  \"topic\": \"demo\"\n}";
  export let mockScenarioText = "";
  export let maxStepsText = "";
  export let maxLoopIterationsText = "";
  export let defaultTimeoutText = "";
  export let runAsync = true;
  export let runDryRun = false;
  export let sessions: readonly WorkflowExecutionSummary[] = [];
  export let selectedExecutionId = "";
  export let selectedSession: WorkflowExecutionStateResponse | null = null;
  export let onExecuteWorkflow: AsyncAction = noop;
  export let onCancelSelectedSession: AsyncAction = noop;
  export let onSelectSession: SelectSessionAction = noop;
</script>

<section class="panel side-panel">
  <h2>Execution</h2>
  {#if selectedWorkflowName === ""}
    <p class="empty">Choose a workflow to run or inspect sessions.</p>
  {:else}
    <div class="execution-form">
      <label for="runtime-variables">Runtime Variables JSON</label>
      <textarea
        id="runtime-variables"
        class="code compact"
        bind:value={runtimeVariablesText}
        spellcheck="false"
        disabled={config?.noExec || busy}
      ></textarea>

      <label for="mock-scenario">Mock Scenario JSON</label>
      <textarea
        id="mock-scenario"
        class="code compact"
        bind:value={mockScenarioText}
        placeholder={`{"node-id":{"provider":"scenario-mock","when":{"always":true},"payload":{"stage":"demo"}}}`}
        spellcheck="false"
        disabled={config?.noExec || busy}
      ></textarea>

      <div class="property-grid execution-grid">
        <div>
          <label for="max-steps">Max Steps</label>
          <input id="max-steps" bind:value={maxStepsText} placeholder="optional" disabled={config?.noExec || busy} />
        </div>
        <div>
          <label for="max-loop">Max Loop Iterations</label>
          <input id="max-loop" bind:value={maxLoopIterationsText} placeholder="optional" disabled={config?.noExec || busy} />
        </div>
        <div>
          <label for="run-timeout">Default Timeout (ms)</label>
          <input id="run-timeout" bind:value={defaultTimeoutText} placeholder="optional" disabled={config?.noExec || busy} />
        </div>
      </div>

      <label class="toggle">
        <input type="checkbox" bind:checked={runAsync} disabled={config?.noExec || busy} />
        <span>Run asynchronously and poll selected session</span>
      </label>

      <label class="toggle">
        <input type="checkbox" bind:checked={runDryRun} disabled={config?.noExec || busy} />
        <span>Dry run</span>
      </label>

      <div class="toolbar-grid single-row">
        <button class="secondary" type="button" on:click={() => void onExecuteWorkflow()} disabled={config?.noExec || busy}>Run Workflow</button>
        <button
          class="ghost"
          type="button"
          on:click={() => void onCancelSelectedSession()}
          disabled={config?.noExec || busy || !canCancelWorkflowExecution(selectedSession?.status)}
        >
          Cancel Selected
        </button>
      </div>
    </div>

    <div class="sessions">
      <div class="section-head">
        <h3>Recent Sessions</h3>
        <span>{sessions.length}</span>
      </div>
      {#if sessions.length === 0}
        <p class="empty">No sessions recorded for {selectedWorkflowName}.</p>
      {:else}
        {#each sessions as session}
          <button
            class:selected={session.workflowExecutionId === selectedExecutionId}
            class="session-card ghost"
            type="button"
            on:click={() => void onSelectSession(session.workflowExecutionId)}
          >
            <div class="session-head">
              <strong class={sessionStatusClass(session.status)}>{session.status}</strong>
              <span>{session.currentNodeId ?? "no active node"}</span>
            </div>
            <div class="session-meta">{session.sessionId}</div>
            <div class="session-meta">Executions: {session.nodeExecutionCounter}</div>
            <div class="session-meta">Started: {session.startedAt}</div>
          </button>
        {/each}
      {/if}
    </div>

    <div class="session-detail">
      <div class="section-head">
        <h3>Selected Session</h3>
        {#if selectedSession}
          <span class={`badge ${sessionStatusClass(selectedSession.status)}`}>{selectedSession.status}</span>
        {/if}
      </div>

      {#if selectedSession}
        <div class="detail-grid">
          <div>
            <span class="detail-label">Execution ID</span>
            <code>{selectedSession.workflowExecutionId}</code>
          </div>
          <div>
            <span class="detail-label">Session ID</span>
            <code>{selectedSession.sessionId}</code>
          </div>
          <div>
            <span class="detail-label">Current Node</span>
            <code>{selectedSession.currentNodeId ?? "-"}</code>
          </div>
          <div>
            <span class="detail-label">Queue</span>
            <code>{selectedSession.queue.length > 0 ? selectedSession.queue.join(", ") : "-"}</code>
          </div>
          <div>
            <span class="detail-label">Transitions</span>
            <code>{selectedSession.transitions.length}</code>
          </div>
        </div>

        {#if selectedSession.lastError}
          <p class="message error compact-message">{selectedSession.lastError}</p>
        {/if}

        <p class="detail-label">Runtime Variables</p>
        <pre>{JSON.stringify(selectedSession.runtimeVariables, null, 2)}</pre>

        <div class="execution-history">
          <div class="section-head">
            <h3>Node Executions</h3>
            <span>{selectedSession.nodeExecutions.length}</span>
          </div>
          {#if selectedSession.nodeExecutions.length === 0}
            <p class="empty">No node executions recorded yet.</p>
          {:else}
            {#each [...selectedSession.nodeExecutions].reverse() as execution}
              <article class="history-card">
                <div class="session-head">
                  <strong>{execution.nodeId}</strong>
                  <span class={execution.status}>{execution.status}</span>
                </div>
                <div class="session-meta">{execution.nodeExecId}</div>
                <div class="session-meta">Started: {execution.startedAt}</div>
                <div class="session-meta">Ended: {execution.endedAt}</div>
              </article>
            {/each}
          {/if}
        </div>
      {:else}
        <p class="empty">Select a session to inspect status, queue, and node execution history.</p>
      {/if}
    </div>
  {/if}
</section>
