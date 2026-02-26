import { describe, expect, test } from "vitest";
import { selectTuiRuntimeMode } from "./runtime";

describe("selectTuiRuntimeMode", () => {
  test("selects fallback mode for resume-session", () => {
    const result = selectTuiRuntimeMode({
      isInteractiveTerminal: true,
      resumeSessionId: "session-123",
    });

    expect(result.mode).toBe("fallback");
    expect(result.reason).toBe("resume-session");
    expect(result.requiresWorkflowArgument).toBe(false);
    expect(result.allowsWorkflowSelectionPrompt).toBe(false);
  });

  test("selects interactive mode for interactive terminal without resume-session", () => {
    const result = selectTuiRuntimeMode({
      isInteractiveTerminal: true,
    });

    expect(result.mode).toBe("interactive");
    expect(result.reason).toBe("interactive-terminal");
    expect(result.requiresWorkflowArgument).toBe(false);
    expect(result.allowsWorkflowSelectionPrompt).toBe(true);
  });

  test("selects fallback mode for non-interactive terminal", () => {
    const result = selectTuiRuntimeMode({
      isInteractiveTerminal: false,
    });

    expect(result.mode).toBe("fallback");
    expect(result.reason).toBe("non-interactive-terminal");
    expect(result.requiresWorkflowArgument).toBe(true);
    expect(result.allowsWorkflowSelectionPrompt).toBe(false);
  });
});
