import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * POSITIVE Zoom Meeting SDK bootstrap, against the REAL pinned CDN build.
 *
 * `live-telehealth.spec.ts` deliberately aborts every source.zoom.us request
 * and proves the honest failure state. This suite is the other half: with
 * network access, the pinned embedded SDK and its documented vendor scripts
 * must load under the visit route's headers, register `ZoomMtgEmbedded`,
 * create a client and INITIALIZE it (the first version loaded only the SDK
 * script and died with "React is not defined" before any client existed).
 * The join that follows is expected to fail — the fixture issues a session
 * for a meeting that does not exist — and must be reported as a join
 * failure, not a load failure.
 *
 * Gated on E2E_ZOOM_SDK=1 because it needs egress to source.zoom.us; CI runs
 * it as its own step so a CDN outage is identifiable. A two-participant
 * meeting (host join, patient join, media, reconnect, end-for-all) is an
 * authorized manual run against a real Zoom account and is documented in
 * docs/telehealth.md, not simulated here.
 */
test.skip(!process.env.E2E_LIVE || !process.env.E2E_ZOOM_SDK, "set E2E_LIVE=1 E2E_ZOOM_SDK=1 with egress to source.zoom.us");

test.describe.configure({ mode: "serial" });

test.beforeAll(resetBackend);

const APPOINTMENT = "abababab-1111-2222-3333-444444444408";

function sundayOfThisWeek(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
}

const DATE = sundayOfThisWeek();

test("the pinned SDK and its vendor scripts load, register, and initialize a client under the visit route's headers", async ({ page }) => {
  const zoomRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://source.zoom.us/")) zoomRequests.push(request.url());
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // Consent first (through the real route), so the server will issue a session.
  const artifact = (await (await page.request.get("/api/live/telehealth/consent-artifact")).json()) as { data: { artifactId: string; artifactVersion: string; contentSha256: string } };
  const consent = await page.request.post("/api/live/telehealth/consent", {
    data: { appointmentId: APPOINTMENT, date: DATE, timeZone: "America/Los_Angeles", ...artifact.data, signerName: "Fixture Patient", agreed: true },
  });
  expect(consent.ok()).toBe(true);

  await page.goto(`/telehealth/visit/${APPOINTMENT}?date=${DATE}`);
  await page.getByRole("button", { name: "Start visit" }).click();

  // The SDK registered and the client initialized: that is the bootstrap the first version never reached.
  await expect(page.getByTestId("zoom-stage")).toHaveAttribute("data-zoom-state", /initialized|joining|failed|connected/, { timeout: 60_000 });
  const registered = await page.evaluate(() => typeof window.ZoomMtgEmbedded?.createClient === "function");
  expect(registered).toBe(true);
  expect(consoleErrors.filter((text) => /React is not defined|ReactDOM is not defined/.test(text))).toEqual([]);
  expect(zoomRequests.some((url) => url.endsWith("/lib/vendor/react.min.js"))).toBe(true);
  expect(zoomRequests.some((url) => /zoom-meeting-embedded-6\.5\.0\.min\.js$/.test(url))).toBe(true);

  // The fixture meeting does not exist at Zoom, so the JOIN fails — and it must say so as a join failure.
  await expect(page.getByTestId("zoom-stage")).toHaveAttribute("data-zoom-state", "failed", { timeout: 60_000 });
  await expect(page.getByTestId("visit-refusal")).toContainText(/could not be joined/);
  await expect(page.getByTestId("visit-refusal")).not.toContainText(/could not be loaded/);
});
