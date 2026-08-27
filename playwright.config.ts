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

/**
 * E2E_DEV_SERVER=1 boots `next dev` instead of `next start`.
 *
 * WHY THIS EXISTS. `next start` forces NODE_ENV=production, which the
 * deployed-runtime detector treats as a deployment signal — correctly, and
 * categorically. The local contract-fixture boundary
 * (`src/server/runtime/contractFixture.ts`) therefore refuses under
 * `next start`, so the deterministic provider produces nothing there.
 *
 * The alternative was to weaken the deployed refusal to obtain browser
 * coverage. That is the trade this repository refuses to make: the suite
 * moves to a runtime where the fixture is legitimately allowed, rather than
 * teaching the fixture to be allowed where it must not be.
 *
 * The longer timeouts below are for `next dev`'s on-demand compilation —
 * the first navigation to a route compiles it. They are not flake
 * tolerance: `retries` stays 0 in both modes, and no assertion is relaxed.
 */
const DEV_SERVER = process.env.E2E_DEV_SERVER === "1";

export default defineConfig({
  testDir: "./e2e",
  workers: 1, // session-state flows stay deterministic
  timeout: DEV_SERVER ? 90_000 : 30_000,
  expect: { timeout: DEV_SERVER ? 20_000 : 5_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    // Fake media devices: getUserMedia succeeds headlessly and MediaRecorder
    // produces real audio chunks — the scribe suite drives the actual capture
    // pipeline. Harmless for suites that never request the microphone.
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    },
  },
  webServer: {
    command: DEV_SERVER ? `npx next dev -p ${PORT}` : `npx next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: true,
    timeout: DEV_SERVER ? 180_000 : 60_000,
  },
});
