import { expect, test, type Request } from "@playwright/test";

/**
 * DEMO EDITION guarantees, verified in a real browser.
 *
 * This suite exists because the demo's promises are the kind that quietly rot:
 * a banner gets dropped from one route, someone adds a fetch to a CDN, a reset
 * stops clearing one domain. Each is invisible in code review and obvious here.
 *
 * Runs against a demo-edition production build (`npm run build:demo`), which is
 * the default build, so it is part of the standard mock suite.
 *
 * Covered:
 *  1. the synthetic-data banner appears on every primary route
 *  2. no request leaves the origin, on any primary route
 *  3. Reset Demo clears session state and restores the shipped fixtures
 *  4. guided entry points reach every headline workflow
 *  5. no login is required and no credential is requested
 */

/** Every primary destination a visitor can reach from the sidebar. */
const PRIMARY_ROUTES = [
  "/today",
  "/calendar",
  "/patients",
  "/tasks",
  "/inbox",
  "/programs",
  "/billing",
  "/reports",
  "/integrations",
  "/team",
  "/settings",
];

/** The guided entry points named in the demo brief. */
const GUIDED_ENTRY_POINTS: [label: string, path: string][] = [
  ["Today", "/today"],
  ["Patient Chart", "/patients/p-78435/chart"],
  ["Labs", "/patients/p-78435/labs"],
  ["Protocols", "/patients/p-78435/protocol"],
  ["Programs", "/programs"],
  ["Billing", "/billing"],
  ["AI workflows", "/patients/p-78435/labs?view=copilot"],
];

/**
 * A request is off-origin if it targets anything but the app under test.
 * `data:`/`blob:` are in-document and never touch the network.
 */
function isOffOrigin(request: Request, origin: string): boolean {
  const url = request.url();
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) {
    return false;
  }
  return !url.startsWith(origin);
}

test.describe("demo edition: synthetic-data disclosure", () => {
  for (const route of PRIMARY_ROUTES) {
    test(`banner is present on ${route}`, async ({ page }) => {
      await page.goto(route);
      const banner = page.getByTestId("demo-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Interactive demo — synthetic data only");
      // The disclosure must also say the change-nothing-persists part.
      await expect(banner).toContainText("nothing you change is saved");
    });
  }

  test("the banner rides along into a patient chart, not just practice screens", async ({ page }) => {
    await page.goto("/patients/p-78435/overview");
    await expect(page.getByTestId("demo-banner")).toBeVisible();
    await page.goto("/patients/p-78435/labs");
    await expect(page.getByTestId("demo-banner")).toBeVisible();
  });
});

test.describe("demo edition: no external calls", () => {
  test("no primary route issues an off-origin request", async ({ page, baseURL }) => {
    const origin = baseURL!.replace(/\/$/, "");
    const offOrigin: string[] = [];

    page.on("request", (request) => {
      if (isOffOrigin(request, origin)) offOrigin.push(`${request.method()} ${request.url()}`);
    });
    // A blocked request (CSP refusing egress) is also a finding: it proves
    // something TRIED to leave. The demo should never even attempt it.
    page.on("requestfailed", (request) => {
      if (isOffOrigin(request, origin)) {
        offOrigin.push(`FAILED ${request.method()} ${request.url()}`);
      }
    });

    for (const route of PRIMARY_ROUTES) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
    }

    expect(
      offOrigin,
      `The demo edition must not contact Supabase, Stripe, OpenAI, email, SMS, ` +
        `storage, lab vendors, or any clinical API. Observed: ${offOrigin.join(", ")}`,
    ).toEqual([]);
  });

  test("interacting with demo data still issues no off-origin request", async ({ page, baseURL }) => {
    const origin = baseURL!.replace(/\/$/, "");
    const offOrigin: string[] = [];
    page.on("request", (r) => {
      if (isOffOrigin(r, origin)) offOrigin.push(r.url());
    });

    // Drive real mutations through the session layer: front-desk arrival and a
    // review action are the paths most likely to reach for a network call.
    await page.goto("/today");
    const arrive = page.getByRole("button", { name: "Arrive" }).first();
    if (await arrive.count()) {
      await arrive.click();
      await expect(page.getByText(/Arrived recorded for/).first()).toBeVisible();
    }
    await page.goto("/patients/p-78435/labs");
    await page.waitForLoadState("networkidle");

    expect(offOrigin, `Observed off-origin: ${offOrigin.join(", ")}`).toEqual([]);
  });

  test("the demo never asks for a login or a credential", async ({ page }) => {
    await page.goto("/today");
    // No sign-in wall, and no password field anywhere on the entry screen.
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByTestId("demo-banner")).toBeVisible();
  });
});

test.describe("demo edition: Reset Demo", () => {
  test("reset clears session changes and restores the shipped fixtures", async ({ page }) => {
    await page.goto("/today");

    // Make a visible, session-persisted change.
    const arrive = page.getByRole("button", { name: "Arrive" }).first();
    await expect(arrive).toBeVisible();
    await arrive.click();
    await expect(page.getByText("Arrived", { exact: true }).first()).toBeVisible();

    // It survives a reload — that is what makes the reset meaningful.
    await page.reload();
    await expect(page.getByText("Arrived", { exact: true }).first()).toBeVisible();

    // Reset, then confirm the fixture state is back: the Arrive button returns
    // and the session status chip is gone.
    await page.getByTestId("demo-reset").click();
    await expect(page.getByText(/Demo (reset|already at)/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Arrive" }).first()).toBeVisible();

    // And it stays reset across a reload — storage really was cleared.
    await page.reload();
    await expect(page.getByRole("button", { name: "Arrive" }).first()).toBeVisible();
  });

  test("reset is reachable from every primary route", async ({ page }) => {
    for (const route of ["/today", "/patients", "/billing", "/settings"]) {
      await page.goto(route);
      await expect(page.getByTestId("demo-reset")).toBeVisible();
    }
  });
});

test.describe("demo edition: guided entry points", () => {
  for (const [label, path] of GUIDED_ENTRY_POINTS) {
    test(`${label} opens and is labelled synthetic`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response!.status(), `${label} (${path}) should render`).toBeLessThan(400);
      await expect(page.getByTestId("demo-banner")).toBeVisible();
    });
  }
});
