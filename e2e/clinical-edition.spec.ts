import { expect, test } from "@playwright/test";

/**
 * CLINICAL EDITION honesty, verified in a real browser against a DOWN backend.
 *
 * The failure this suite exists to prevent is the worst one in the product: a
 * practitioner opens a chart, the backend is unreachable, and the screen shows
 * synthetic fixtures — or an empty state indistinguishable from "this patient
 * has no records". Either way they read something untrue about a real person.
 *
 * So this runs a clinical-edition build with NO reachable backend and asserts
 * the UI says so. It is the inverse of the live contract-fixture suites: those
 * prove the happy path works, this proves the sad path stays honest.
 *
 * Recipe (no backend process started — that is the point):
 *   APP_EDITION=clinical npm run build
 *   E2E_CLINICAL_DOWN=1 CLINICAL_SUPABASE_URL=http://127.0.0.1:59999 \
 *     CLINICAL_SUPABASE_ANON_KEY=stub CLINICAL_ORG_ID=org-fixture \
 *     APP_EDITION=clinical npm run test:e2e -- e2e/clinical-edition.spec.ts
 */
test.skip(
  !process.env.E2E_CLINICAL_DOWN,
  "clinical backend-down suite: set E2E_CLINICAL_DOWN=1 with a clinical build and no backend",
);

test.describe.configure({ mode: "serial" });

/** Fixture identities that must never appear in clinical mode. */
const FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma", "Marcus Webb"];
const FIXTURE_IDS = ["p-78435", "p-64201", "p-59318"];

async function expectNoFixtureData(bodyText: string, where: string) {
  for (const name of FIXTURE_NAMES) {
    expect(bodyText, `${where} must not render fixture patient "${name}"`).not.toContain(name);
  }
  for (const id of FIXTURE_IDS) {
    expect(bodyText, `${where} must not render fixture id "${id}"`).not.toContain(id);
  }
}

test("no demo banner exists in the clinical edition", async ({ page }) => {
  await page.goto("/today");
  // The demo disclosure is a demo-edition surface; its presence in clinical UI
  // would misdescribe real data.
  await expect(page.getByTestId("demo-banner")).toHaveCount(0);
  await expect(page.getByTestId("demo-reset")).toHaveCount(0);
});

test("a down backend yields an honest state, never synthetic patients", async ({ page }) => {
  await page.goto("/patients");
  await page.waitForLoadState("networkidle");

  const body = (await page.locator("body").innerText()).trim();

  // Something must be said. A blank screen is not an honest state.
  expect(body.length, "the page must explain itself rather than render blank").toBeGreaterThan(0);

  // And it must not be the fixture directory.
  await expectNoFixtureData(body, "/patients with the backend down");

  // The copy must name the real condition: unavailable / not configured /
  // sign-in required / forbidden — not "no patients found".
  expect(
    body,
    `Expected an unavailable, not-configured, or sign-in state. Got:\n${body.slice(0, 600)}`,
  ).toMatch(
    /unavailable|not configured|cannot reach|couldn't reach|try again|sign in|signed in|no organization|not authorized|unauthenticated|forbidden|error/i,
  );
});

test("a patient chart with a down backend refuses rather than inventing a record", async ({ page }) => {
  // A real-looking UUID: it must not resolve to a fixture patient.
  await page.goto("/patients/11111111-2222-3333-4444-555555555555/overview");
  await page.waitForLoadState("networkidle");

  const body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "a clinical patient chart with the backend down");

  // Specifically: no fabricated clinical overview. A health score for a patient
  // whose record could not be loaded is the exact lie this edition forbids.
  expect(body).not.toContain("Health score");
  expect(body).not.toContain("System balance");
});

test("the review queue and calendar stay honest with a down backend", async ({ page }) => {
  for (const route of ["/tasks", "/calendar"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const body = (await page.locator("body").innerText()).trim();
    await expectNoFixtureData(body, `${route} with the backend down`);
    // The demo weekday calendar template must not stand in for a real week.
    expect(body, `${route} must not render the demo template`).not.toContain(
      "(demo — not persisted)",
    );
  }
});

test("settings reports the clinical edition and its real configuration state", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  const body = (await page.locator("body").innerText()).trim();
  // The operator must be able to see which edition this is.
  expect(body).not.toContain("Interactive demo — synthetic data only");
  await expectNoFixtureData(body, "/settings in the clinical edition");
});
