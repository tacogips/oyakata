#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertWorkspacePackage,
  resolvePackageOptionsFromModuleUrl,
  resolvePackageBinary,
} from "./ui-framework.mjs";

const packageOptions = resolvePackageOptionsFromModuleUrl(import.meta.url);

assertWorkspacePackage(
  "vitest",
  "run the interactive UI test server",
  packageOptions,
);
assertWorkspacePackage(
  "@vitest/ui",
  "run the interactive UI test server",
  packageOptions,
);

const result = spawnSync(
  resolvePackageBinary("vitest", "vitest", packageOptions),
  ["--ui", ...process.argv.slice(2)],
  {
    cwd: packageOptions.packageRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
