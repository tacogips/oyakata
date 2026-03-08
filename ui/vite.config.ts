import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const UI_ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: UI_ROOT,
  plugins: [svelte()],
  build: {
    outDir: path.join(UI_ROOT, "dist"),
    emptyOutDir: true,
  },
});
