#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertUiFrameworkPackages,
  detectUiFramework,
  resolvePackageBinary,
} from "./ui-framework.mjs";

const framework = detectUiFramework();
assertUiFrameworkPackages(framework, "build");

const result = spawnSync(
  resolvePackageBinary("vite", "vite"),
  ["build", "--config", "ui/vite.config.ts"],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
