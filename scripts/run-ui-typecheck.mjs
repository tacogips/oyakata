#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertUiFrameworkPackages,
  detectUiFramework,
  resolvePackageOptionsFromModuleUrl,
  resolvePackageBinary,
  uiTsconfigPath,
} from "./ui-framework.mjs";

const packageOptions = resolvePackageOptionsFromModuleUrl(import.meta.url);
const framework = detectUiFramework(packageOptions);
assertUiFrameworkPackages(framework, "typecheck", packageOptions);
const command = [
  resolvePackageBinary("typescript", "tsc", packageOptions),
  "--noEmit",
  "-p",
  uiTsconfigPath(framework, packageOptions),
];

const [executable, ...args] = command;
const result = spawnSync(executable, args, {
  cwd: packageOptions.packageRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
