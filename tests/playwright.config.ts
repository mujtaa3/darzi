/**
 * The attack suite's runner configuration.
 *
 * Three real engines, because each implements the enforcement we depend on in
 * its own code and they have already been measured to differ. Chrome is the
 * installed channel build, not Playwright's Chromium, so the run reflects what
 * users actually have (this matters for CSP directives Chromium-the-project
 * ships before Chrome-the-product does, or after).
 *
 * `retries: 0` on purpose: a test that passes on retry is a test that can
 * hide a leak. `workers: 1` because the witness listens on fixed ports.
 */
import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  testDir: "./attacks",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8009",
    viewport: { width: 1100, height: 1400 },
  },
  webServer: {
    command: "node server.js",
    cwd: REPO,
    port: 8009,
    env: { PORT: "8009" },
    reuseExistingServer: false,
    timeout: 15_000,
  },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
