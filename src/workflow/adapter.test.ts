import { describe, expect, test } from "vitest";
import {
  AdapterExecutionError,
  normalizeAdapterOutput,
  parseJsonObjectCandidate,
} from "./adapter";

describe("normalizeAdapterOutput", () => {
  test("normalizes valid adapter output", () => {
    const normalized = normalizeAdapterOutput(
      {
        provider: "provider-x",
        model: "model-x",
        promptText: "hello",
        completionPassed: true,
        when: { always: true },
        payload: { value: 1 },
      },
      "fallback-model",
    );

    expect(normalized.provider).toBe("provider-x");
    expect(normalized.model).toBe("model-x");
    expect(normalized.when["always"]).toBe(true);
  });

  test("throws invalid_output for malformed payload", () => {
    expect(() =>
      normalizeAdapterOutput(
        {
          provider: "provider-x",
          promptText: "hello",
          completionPassed: true,
          when: { always: "true" },
          payload: { value: 1 },
        },
        "fallback-model",
      ),
    ).toThrowError(AdapterExecutionError);
  });
});

describe("parseJsonObjectCandidate", () => {
  test("accepts a fenced json object response", () => {
    expect(
      parseJsonObjectCandidate(
        '```json\n{\n  "summary": "ok"\n}\n```',
        "test source",
      ),
    ).toEqual({ summary: "ok" });
  });

  test("rejects non-object json responses", () => {
    expect(() =>
      parseJsonObjectCandidate("[1,2,3]", "test source"),
    ).toThrowError(AdapterExecutionError);
  });
});
