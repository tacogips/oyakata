#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertUiFrameworkPackages,
  detectUiFramework,
  frontendModeFromUiFramework,
  resolvePackageOptionsFromModuleUrl,
  resolvePackageBinary,
} from "./ui-framework.mjs";
import {
  resolveBuiltFrontendModeMetadataPath,
  serializeBuiltFrontendModeMetadata,
} from "./ui-built-assets.mjs";

const packageOptions = resolvePackageOptionsFromModuleUrl(import.meta.url);
const packageRoot = packageOptions.packageRoot;

const framework = detectUiFramework(packageOptions);
assertUiFrameworkPackages(framework, "build", packageOptions);

const result = spawnSync(
  resolvePackageBinary("vite", "vite", packageOptions),
  ["build", "--config", path.join(packageRoot, "ui", "vite.config.ts")],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

if (result.status === 0) {
  const metadataPath = resolveBuiltFrontendModeMetadataPath({ packageRoot });
  mkdirSync(path.dirname(metadataPath), { recursive: true });
  writeFileSync(
    metadataPath,
    serializeBuiltFrontendModeMetadata(frontendModeFromUiFramework(framework)),
    "utf8",
  );
}

process.exit(result.status ?? 1);
