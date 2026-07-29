import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.ZAPPAD_E2E_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e/zappad",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  outputDir: "output/playwright/zappad/test-results",
  reporter: [["line"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-lifecycle",
      testMatch: /zappad-lifecycle\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-responsive",
      testMatch: /zappad-responsive\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-responsive",
      testMatch: /zappad-responsive\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
});
