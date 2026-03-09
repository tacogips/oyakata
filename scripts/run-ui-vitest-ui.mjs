#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertWorkspacePackage,
  resolvePackageBinary,
} from "./ui-framework.mjs";

assertWorkspacePackage("vitest", "run the interactive UI test server");
assertWorkspacePackage("@vitest/ui", "run the interactive UI test server");

const result = spawnSync(
  resolvePackageBinary("vitest", "vitest"),
  ["--ui", ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
