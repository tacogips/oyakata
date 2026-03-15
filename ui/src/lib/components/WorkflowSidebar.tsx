import { For, Show, type JSX } from "solid-js";

import type { UiConfigResponse } from "../../../../src/shared/ui-contract";
import { isValidWorkflowNameInput } from "../editor-support";
import { Badge, Button } from "./ui";

type AsyncAction = () => void | Promise<void>;
type SelectWorkflowAction = (workflowName: string) => void | Promise<void>;

const noop = (): void => {};

export interface WorkflowSidebarProps {
  readonly workflows: readonly string[];
  readonly selectedWorkflowName: string;
  readonly newWorkflowName: string;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly hasEditableBundle: boolean;
  readonly workflowDirty: boolean;
  readonly config: UiConfigResponse | null;
  readonly onSelectedWorkflowNameChange: (workflowName: string) => void;
  readonly onNewWorkflowNameChange: (workflowName: string) => void;
  readonly onSelectWorkflow?: SelectWorkflowAction;
  readonly onCreateWorkflow?: AsyncAction;
  readonly onValidateWorkflow?: AsyncAction;
  readonly onSaveWorkflow?: AsyncAction;
  readonly onRefreshSessions?: AsyncAction;
}

function createWorkflowDisabled(props: WorkflowSidebarProps): boolean {
  return (
    !isValidWorkflowNameInput(props.newWorkflowName.trim()) ||
    props.config?.readOnly === true ||
    Boolean(props.config?.fixedWorkflowName) ||
    props.busy
  );
}

export default function WorkflowSidebar(
  props: WorkflowSidebarProps,
): JSX.Element {
  const onSelectWorkflow = (): SelectWorkflowAction =>
    props.onSelectWorkflow ?? noop;
  const onCreateWorkflow = (): AsyncAction => props.onCreateWorkflow ?? noop;
  const onValidateWorkflow = (): AsyncAction =>
    props.onValidateWorkflow ?? noop;
  const onSaveWorkflow = (): AsyncAction => props.onSaveWorkflow ?? noop;
  const onRefreshSessions = (): AsyncAction => props.onRefreshSessions ?? noop;

  return (
    <section class="panel side-panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Control</p>
          <h2>Workflows</h2>
        </div>
        <Badge variant="outline">{props.workflows.length} total</Badge>
      </div>
      <label for="workflow">Select Workflow</label>
      <select
        id="workflow"
        value={props.selectedWorkflowName}
        disabled={props.loading || props.busy}
        onChange={(event) => {
          const workflowName = event.currentTarget.value;
          props.onSelectedWorkflowNameChange(workflowName);
          void onSelectWorkflow()(workflowName);
        }}
      >
        <option value="" selected={props.selectedWorkflowName.length === 0}>
          Select a workflow
        </option>
        <For each={props.workflows}>
          {(workflowName) => (
            <option
              value={workflowName}
              selected={workflowName === props.selectedWorkflowName}
            >
              {workflowName}
            </option>
          )}
        </For>
      </select>

      <Show when={!props.loading && props.workflows.length === 0}>
        <div class="section-card compact-message">
          <p class="subtle">
            No workflows are available yet. Create one below to start editing
            and running sessions.
          </p>
        </div>
      </Show>

      <Show
        when={
          !props.loading &&
          props.workflows.length > 0 &&
          props.selectedWorkflowName.length === 0
        }
      >
        <div class="section-card compact-message">
          <p class="subtle">
            Select a workflow to load its editor state, validation results, and
            recent executions.
          </p>
        </div>
      </Show>

      <div class="create section-card">
        <label for="new-workflow">Create Workflow</label>
        <input
          id="new-workflow"
          value={props.newWorkflowName}
          placeholder="workflow-name"
          disabled={
            props.config?.readOnly === true ||
            Boolean(props.config?.fixedWorkflowName) ||
            props.busy
          }
          onInput={(event) => {
            props.onNewWorkflowNameChange(event.currentTarget.value);
          }}
        />
        <Button
          variant="secondary"
          type="button"
          disabled={createWorkflowDisabled(props)}
          onClick={() => void onCreateWorkflow()()}
        >
          Create
        </Button>
      </div>

      <div class="toolbar-grid quick-actions">
        <Button
          variant="outline"
          type="button"
          disabled={!props.hasEditableBundle || props.busy}
          onClick={() => void onValidateWorkflow()()}
        >
          Validate
        </Button>
        <Button
          type="button"
          disabled={
            !props.hasEditableBundle ||
            !props.workflowDirty ||
            props.config?.readOnly === true ||
            props.busy
          }
          onClick={() => void onSaveWorkflow()()}
        >
          Save
        </Button>
        <Button
          variant="outline"
          type="button"
          disabled={props.selectedWorkflowName.length === 0 || props.busy}
          onClick={() => void onRefreshSessions()()}
        >
          Refresh Sessions
        </Button>
      </div>

      <div class="list workflow-list">
        <Show
          when={props.workflows.length > 0}
          fallback={<p class="empty">No workflows found.</p>}
        >
          <For each={props.workflows}>
            {(workflowName) => (
              <button
                classList={{
                  selected: workflowName === props.selectedWorkflowName,
                }}
                class="workflow-link ghost"
                type="button"
                onClick={() => {
                  props.onSelectedWorkflowNameChange(workflowName);
                  void onSelectWorkflow()(workflowName);
                }}
              >
                {workflowName}
              </button>
            )}
          </For>
        </Show>
      </div>
    </section>
  );
}
