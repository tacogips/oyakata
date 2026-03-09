import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import {
  assertUiFrameworkPackages,
  detectUiFramework,
} from "../scripts/ui-framework.mjs";

const UI_ROOT = fileURLToPath(new URL(".", import.meta.url));
const framework = detectUiFramework({ uiRoot: UI_ROOT });
if (framework !== "solid") {
  throw new Error(
    `ui/vite.config.ts expects the checked-in frontend entrypoint to be SolidJS, but detected '${framework}'.`,
  );
}

assertUiFrameworkPackages("solid", "build", {
  packageRoot: path.join(UI_ROOT, ".."),
  uiRoot: UI_ROOT,
});

export default defineConfig({
  root: UI_ROOT,
  plugins: [solid()],
  build: {
    outDir: path.join(UI_ROOT, "dist"),
    emptyOutDir: true,
  },
});
