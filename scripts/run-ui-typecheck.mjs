#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertUiFrameworkPackages,
  detectUiFramework,
  resolvePackageBinary,
  uiTsconfigPath,
} from "./ui-framework.mjs";

const framework = detectUiFramework();
assertUiFrameworkPackages(framework, "typecheck");
const command = [
  resolvePackageBinary("typescript", "tsc"),
  "--noEmit",
  "-p",
  uiTsconfigPath(framework),
];

const [executable, ...args] = command;
const result = spawnSync(executable, args, {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
