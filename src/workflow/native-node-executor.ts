export type { NativeNodeExecutionInput } from "./native-node-executor-process";

import { AdapterExecutionError, type AdapterExecutionOutput } from "./adapter";
import { executeAddonNode } from "./native-node-executor-addons";
import {
  type NativeNodeExecutionContext,
  type NativeNodeExecutionInput,
  executeCommandNode,
  executeContainerNode,
} from "./native-node-executor-process";

export async function executeNativeNode(
  input: NativeNodeExecutionInput,
  context: NativeNodeExecutionContext,
): Promise<AdapterExecutionOutput> {
  switch (input.node.nodeType) {
    case "command":
      return await executeCommandNode(input, context);
    case "container":
      return await executeContainerNode(input, context);
    case "addon":
      return await executeAddonNode(input, context);
    default:
      throw new AdapterExecutionError(
        "policy_blocked",
        `node '${input.nodeId}' does not use a native command/container/add-on executor`,
      );
  }
}
