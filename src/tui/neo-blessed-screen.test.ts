import { describe, expect, test } from "vitest";
import { resolveSelectedWorkflowName } from "./neo-blessed-screen";

describe("resolveSelectedWorkflowName", () => {
  test("returns selected workflow when index is in range", () => {
    expect(resolveSelectedWorkflowName(1, ["a", "b", "c"])).toBe("b");
  });

  test("returns undefined when index is out of range", () => {
    expect(resolveSelectedWorkflowName(-1, ["a"])).toBeUndefined();
    expect(resolveSelectedWorkflowName(3, ["a", "b"])).toBeUndefined();
  });
});
