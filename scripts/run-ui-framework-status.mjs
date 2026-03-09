#!/usr/bin/env node

import process from "node:process";
import {
  collectUiFrameworkStatus,
  formatUiFrameworkStatus,
} from "./ui-framework.mjs";

process.stdout.write(formatUiFrameworkStatus(collectUiFrameworkStatus()));
