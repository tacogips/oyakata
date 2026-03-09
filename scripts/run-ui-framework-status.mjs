#!/usr/bin/env node

import process from "node:process";
import {
  collectUiFrameworkStatus,
  formatUiFrameworkStatus,
  resolvePackageOptionsFromModuleUrl,
} from "./ui-framework.mjs";

const packageOptions = resolvePackageOptionsFromModuleUrl(import.meta.url);

process.stdout.write(
  formatUiFrameworkStatus(collectUiFrameworkStatus(packageOptions)),
);
