import { Show, type JSX } from "solid-js";

import type { UiConfigResponse } from "../../../../src/shared/ui-contract";

export interface AppShellProps {
  readonly config: UiConfigResponse | null;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly errorMessage: string;
  readonly infoMessage: string;
  readonly onReload: () => void | Promise<void>;
  readonly sidebar: JSX.Element;
  readonly editor: JSX.Element;
  readonly execution: JSX.Element;
}

export default function AppShell(props: AppShellProps): JSX.Element {
  const reloadDisabled = (): boolean => props.loading || props.busy;
  const lede =
    "The SolidJS editor is active and continues to use the existing workflow and session API contract behind the same ui/dist serving boundary.";

  return (
    <div class="page">
      <header class="hero">
        <div>
          <p class="eyebrow">Browser Workflow Editor</p>
          <h1>oyakata Workflow Editor</h1>
          <p class="lede">{lede}</p>
        </div>
        <div class="hero-actions">
          <button
            class="ghost"
            type="button"
            onClick={() => void props.onReload()}
            disabled={reloadDisabled()}
          >
            Reload
          </button>
        </div>
      </header>

      <Show when={props.config}>
        {(config) => (
          <section class="modes">
            <Show when={config().fixedWorkflowName}>
              {(workflowName) => (
                <span class="badge">Fixed workflow: {workflowName()}</span>
              )}
            </Show>
            <Show when={config().readOnly}>
              <span class="badge warn">Read-only</span>
            </Show>
            <Show when={config().noExec}>
              <span class="badge warn">Execution disabled</span>
            </Show>
            <span class="badge subtle">Frontend mode: {config().frontend}</span>
          </section>
        )}
      </Show>

      <Show when={props.errorMessage.length > 0}>
        <p class="message error">{props.errorMessage}</p>
      </Show>

      <Show when={props.infoMessage.length > 0}>
        <p class="message info">{props.infoMessage}</p>
      </Show>

      <main class="layout">
        {props.sidebar}
        {props.editor}
        {props.execution}
      </main>
    </div>
  );
}
