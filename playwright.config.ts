import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/screenshot",
  timeout: 30000,
  expect: { toHaveScreenshot: { maxDiffPixels: 100 } },
  use: {
    baseURL: "http://localhost:8414",
    viewport: { width: 1440, height: 900 },
    browserName: "chromium",
  },
  webServer: {
    command: "node server.cjs",
    port: 8414,
    reuseExistingServer: true,
    timeout: 15000,
  },
});
