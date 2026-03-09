#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolvePackageBinary } from "./ui-framework.mjs";

const args = process.argv.slice(2);

if (args.length === 0) {
  throw new Error("run-prettier.mjs requires at least one prettier argument");
}

const result = spawnSync(resolvePackageBinary("prettier", "prettier"), args, {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
