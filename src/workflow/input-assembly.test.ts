import { describe, expect, test } from "vitest";
import { assembleNodeInput } from "./input-assembly";
import type { NodePayload } from "./types";

function makeNode(overrides: Partial<NodePayload> = {}): NodePayload {
  return {
    id: "step-1",
    model: "tacogips/codex-agent",
    promptTemplate: "hello {{topic}}",
    variables: { topic: "default-topic" },
    ...overrides,
  };
}

describe("assembleNodeInput", () => {
  test("renders prompt with merged variables and returns null arguments when no template/bindings", () => {
    const assembled = assembleNodeInput({
      runtimeVariables: { topic: "runtime-topic" },
      node: makeNode(),
      upstream: [],
      transcript: [],
    });

    expect(assembled.promptText).toBe("hello runtime-topic");
    expect(assembled.arguments).toBeNull();
  });

  test("materializes bindings from variables and node output", () => {
    const assembled = assembleNodeInput({
      runtimeVariables: { topic: "runtime-topic" },
      node: makeNode({
        argumentsTemplate: { task: { topic: "", upstreamNode: "" } },
        argumentBindings: [
          {
            targetPath: "task.topic",
            source: "variables",
            sourcePath: "topic",
            required: true,
          },
          {
            targetPath: "task.upstreamNode",
            source: "node-output",
            sourceRef: "oyakata-manager",
            sourcePath: "output.payload.nodeId",
            required: true,
          },
        ],
      }),
      upstream: [
        {
          fromNodeId: "oyakata-manager",
          output: {
            payload: { nodeId: "oyakata-manager" },
          },
        },
      ],
      transcript: [],
    });

    expect(assembled.arguments).toEqual({
      task: {
        topic: "runtime-topic",
        upstreamNode: "oyakata-manager",
      },
    });
  });

  test("supports transcript binding source", () => {
    const assembled = assembleNodeInput({
      runtimeVariables: {},
      node: makeNode({
        argumentsTemplate: {},
        argumentBindings: [
          {
            targetPath: "history.turns",
            source: "conversation-transcript",
            required: true,
          },
        ],
      }),
      upstream: [],
      transcript: [{ turn: 1 }, { turn: 2 }],
    });

    expect(assembled.arguments).toEqual({
      history: { turns: [{ turn: 1 }, { turn: 2 }] },
    });
  });

  test("throws deterministic error for missing required binding", () => {
    expect(() =>
      assembleNodeInput({
        runtimeVariables: {},
        node: makeNode({
          argumentsTemplate: {},
          argumentBindings: [
            {
              targetPath: "task.requiredInput",
              source: "human-input",
              sourcePath: "response",
              required: true,
            },
          ],
        }),
        upstream: [],
        transcript: [],
      }),
    ).toThrow(/required binding resolution failed/);
  });
});
