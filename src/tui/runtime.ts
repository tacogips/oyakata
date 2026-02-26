export type TuiRuntimeMode = "interactive" | "fallback";

export type TuiRuntimeReason =
  | "resume-session"
  | "interactive-terminal"
  | "non-interactive-terminal";

export interface TuiRuntimeSelectionInput {
  readonly isInteractiveTerminal: boolean;
  readonly resumeSessionId?: string;
}

export interface TuiRuntimeSelection {
  readonly mode: TuiRuntimeMode;
  readonly reason: TuiRuntimeReason;
  readonly requiresWorkflowArgument: boolean;
  readonly allowsWorkflowSelectionPrompt: boolean;
}

export interface TuiInteractiveScreenContext {
  readonly workflowNames: readonly string[];
}

export interface TuiInteractiveScreenResult {
  readonly workflowName: string;
  readonly runtimeVariables: Readonly<Record<string, unknown>>;
}

export interface TuiInteractiveScreenAdapter {
  readonly run: (context: TuiInteractiveScreenContext) => Promise<TuiInteractiveScreenResult>;
}

export function selectTuiRuntimeMode(input: TuiRuntimeSelectionInput): TuiRuntimeSelection {
  if (input.resumeSessionId !== undefined) {
    return {
      mode: "fallback",
      reason: "resume-session",
      requiresWorkflowArgument: false,
      allowsWorkflowSelectionPrompt: false,
    };
  }

  if (input.isInteractiveTerminal) {
    return {
      mode: "interactive",
      reason: "interactive-terminal",
      requiresWorkflowArgument: false,
      allowsWorkflowSelectionPrompt: true,
    };
  }

  return {
    mode: "fallback",
    reason: "non-interactive-terminal",
    requiresWorkflowArgument: true,
    allowsWorkflowSelectionPrompt: false,
  };
}
