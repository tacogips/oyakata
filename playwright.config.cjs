const { defineConfig, devices } = require("@playwright/test");

const isCi = process.env["CI"] === "true";
const baseURL = process.env["OYAKATA_E2E_BASE_URL"] ?? "http://127.0.0.1:5173";

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  reporter: isCi ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
