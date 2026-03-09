import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ui/src/**/*.test.ts", "ui/src/**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**", "ui/dist/**", ".direnv/**"],
  },
});
