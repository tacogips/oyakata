<script lang="ts">
  import type { UiConfigResponse } from "../../../../src/shared/ui-contract";
  import { isValidWorkflowNameInput } from "../editor-support";

  type AsyncAction = () => void | Promise<void>;
  type SelectWorkflowAction = (workflowName: string) => void | Promise<void>;

  const noop = (): void => {};

  export let workflows: readonly string[] = [];
  export let selectedWorkflowName = "";
  export let newWorkflowName = "";
  export let loading = false;
  export let busy = false;
  export let hasEditableBundle = false;
  export let workflowDirty = false;
  export let config: UiConfigResponse | null = null;
  export let onSelectWorkflow: SelectWorkflowAction = noop;
  export let onCreateWorkflow: AsyncAction = noop;
  export let onValidateWorkflow: AsyncAction = noop;
  export let onSaveWorkflow: AsyncAction = noop;
  export let onRefreshSessions: AsyncAction = noop;

  function handleSelectChange(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    void onSelectWorkflow(target.value);
  }

  function handleWorkflowButtonClick(workflowName: string): void {
    selectedWorkflowName = workflowName;
    void onSelectWorkflow(workflowName);
  }
</script>

<section class="panel side-panel">
  <h2>Workflows</h2>
  <label for="workflow">Select Workflow</label>
  <select id="workflow" bind:value={selectedWorkflowName} on:change={handleSelectChange} disabled={loading || busy}>
    <option value="">Select a workflow</option>
    {#each workflows as workflowName}
      <option value={workflowName}>{workflowName}</option>
    {/each}
  </select>

  <div class="create">
    <label for="new-workflow">Create Workflow</label>
    <input
      id="new-workflow"
      bind:value={newWorkflowName}
      placeholder="workflow-name"
      disabled={config?.readOnly || Boolean(config?.fixedWorkflowName) || busy}
    />
    <button
      class="secondary"
      type="button"
      on:click={() => void onCreateWorkflow()}
      disabled={!isValidWorkflowNameInput(newWorkflowName.trim()) || config?.readOnly || Boolean(config?.fixedWorkflowName) || busy}
    >
      Create
    </button>
  </div>

  <div class="toolbar-grid">
    <button class="ghost" type="button" on:click={() => void onValidateWorkflow()} disabled={!hasEditableBundle || busy}>Validate</button>
    <button type="button" on:click={() => void onSaveWorkflow()} disabled={!hasEditableBundle || !workflowDirty || config?.readOnly || busy}>Save</button>
    <button class="ghost" type="button" on:click={() => void onRefreshSessions()} disabled={!selectedWorkflowName || busy}>Refresh Sessions</button>
  </div>

  <div class="list">
    {#if workflows.length === 0}
      <p class="empty">No workflows found.</p>
    {:else}
      {#each workflows as workflowName}
        <button
          class:selected={workflowName === selectedWorkflowName}
          class="workflow-link ghost"
          type="button"
          on:click={() => handleWorkflowButtonClick(workflowName)}
        >
          {workflowName}
        </button>
      {/each}
    {/if}
  </div>
</section>
