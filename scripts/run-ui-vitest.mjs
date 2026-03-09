#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertWorkspacePackage,
  resolvePackageOptionsFromModuleUrl,
  resolvePackageBinary,
} from "./ui-framework.mjs";

const packageOptions = resolvePackageOptionsFromModuleUrl(import.meta.url);

assertWorkspacePackage("vitest", "run UI tests", packageOptions);

const result = spawnSync(
  resolvePackageBinary("vitest", "vitest", packageOptions),
  ["run", "--config", "vitest.ui.config.ts"],
  {
    cwd: packageOptions.packageRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
