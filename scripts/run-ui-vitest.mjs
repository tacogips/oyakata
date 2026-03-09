#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertWorkspacePackage,
  resolvePackageBinary,
} from "./ui-framework.mjs";

assertWorkspacePackage("vitest", "run UI tests");

const result = spawnSync(
  resolvePackageBinary("vitest", "vitest"),
  ["run", "--config", "vitest.ui.config.ts"],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
