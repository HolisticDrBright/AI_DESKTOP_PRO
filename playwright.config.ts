import { defineConfig } from "@playwright/test";

/**
 * E2E suite for the MOCK/demo app (no live backend required).
 *
 * Run `npm run build` once, then `npm run test:e2e` — the config boots the
 * production server itself (or reuses one already listening on the port).
 *
 * PW_CHROMIUM_PATH: optional absolute path to a Chromium binary for
 * environments with a pre-installed browser (CI images / sandboxes). On a
 * normal machine leave it unset and run `npx playwright install chromium`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3114);

export default defineConfig({
  testDir: "./e2e",
  workers: 1, // session-state flows stay deterministic
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
