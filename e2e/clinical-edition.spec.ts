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

/**
 * Wordings that count as an honest "this did not load" state.
 *
 * An ALLOW-LIST, not a weakening: the surrounding assertions still require that
 * no fixture patient appears and that no empty-state copy is shown. What this
 * pattern decides is only whether the screen ADMITTED the failure. The app's
 * real copy — "This didn't load" over "Unable to load the directory right
 * now." — was not listed, so the suite failed on a screen that was behaving
 * correctly. That is a defect in the list, not in the product.
 */
const HONEST_FAILURE =
  /unavailable|not configured|cannot reach|couldn.t reach|couldn.t load|didn.t load|unable to load|could not be loaded|try again|retry|sign in|signed out|no organization|not authorized|unauthenticated|forbidden|error/i;

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
    HONEST_FAILURE,
  );
});

test("the governed copilot stays honest with a down backend", async ({ page }) => {
  // Phase 10B.1 proof 18. With no backend, nobody is in a position to say
  // whether a provider is configured or approved — and the one thing the
  // screen must never do is fill the gap with deterministic fixture
  // content, which would look exactly like a real answer.
  await page.goto("/patients/11111111-2222-3333-4444-555555555555/labs?view=copilot");
  await page.waitForLoadState("networkidle");

  const body = (await page.locator("body").innerText()).trim();
  expect(body.length, "the copilot must explain itself rather than render blank").toBeGreaterThan(0);
  expect(
    body,
    `Expected an honest unavailable state on the copilot tab. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);

  // No fixture provider identity, no fixture draft body, no invented
  // approval. "Approved" must not appear as a gate verdict when the
  // records that would back it were never read.
  expect(body).not.toContain("fixture-copilot-v1");
  expect(body).not.toContain("fixture:governed-synthetic");
  expect(body).not.toContain("Live transacted");
  expect(body).not.toMatch(/\bHIPAA-ready\b/i);
  await expectNoFixtureData(body, "the copilot tab with the backend down");
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

test("the today brief and protocol screen stay honest with a down backend", async ({ page }) => {
  // PHASE 2: both screens gained real aggregations. With the backend down they
  // must say so — never fall back to a template day or a template protocol.
  await page.goto("/today");
  await page.waitForLoadState("networkidle");
  let body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/today with the backend down");
  expect(body.length, "/today must explain itself rather than render blank").toBeGreaterThan(0);
  expect(
    body,
    `/today must report the schedule as unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // An empty day and an unreachable backend are different claims. With the
  // backend down the screen must NOT assert that nothing is scheduled.
  expect(body).not.toContain("No appointments are scheduled for today");

  await page.goto("/patients/11111111-2222-3333-4444-555555555555/protocol");
  await page.waitForLoadState("networkidle");
  body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "a clinical protocol screen with the backend down");
  // No fabricated plan, and no false claim that this patient simply has none.
  expect(body).not.toContain("Interaction review not completed");
  expect(body).not.toContain("This patient has no protocol on file");
  expect(body).not.toContain("Active version");
});

test("the programs workspace stays honest with a down backend", async ({ page }) => {
  // PHASE 3: /programs is a real workspace now. With the backend down it must
  // refuse — never a synthetic library, and never a false "no programs yet"
  // (an empty org and an unreachable backend are different claims).
  await page.goto("/programs");
  await page.waitForLoadState("networkidle");
  const body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/programs with the backend down");
  expect(
    body,
    `/programs must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  expect(body).not.toContain("No programs yet");
  expect(body).not.toContain("Enrollments:");
});

test("the inbox stays honest with a down backend", async ({ page }) => {
  // PHASE 4: /inbox is a real workspace now. With the backend down it must
  // refuse — never synthetic threads, and never a false "Inbox empty" (an
  // empty inbox and an unreachable backend are different claims).
  await page.goto("/inbox");
  await page.waitForLoadState("networkidle");
  const body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/inbox with the backend down");
  expect(
    body,
    `/inbox must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  expect(body).not.toContain("Inbox empty");
  expect(body).not.toContain("No patient conversations exist");
  // And nothing on a dead screen may claim delivery.
  expect(body).not.toContain("sent (provider confirmed)");
});

test("the patient-sync surfaces stay honest with a down backend", async ({ page }) => {
  // PHASE 5: the Patient App tab and Integrations sync operations are real
  // surfaces now. With the backend down they must refuse — never a false
  // "not linked" claim (an unlinked patient and an unreachable backend are
  // different statements), and never fabricated counts.
  await page.goto("/patients/11111111-2222-3333-4444-555555555555/app-sync");
  await page.waitForLoadState("networkidle");
  let body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "the patient-sync tab with the backend down");
  expect(
    body,
    `/app-sync must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  expect(body).not.toContain("This patient's app is not linked");
  expect(body).not.toContain("Create connection invitation");

  await page.goto("/integrations");
  await page.waitForLoadState("networkidle");
  body = (await page.locator("body").innerText)
    ? (await page.locator("body").innerText()).trim()
    : "";
  await expectNoFixtureData(body, "/integrations with the backend down");
  expect(
    body,
    `/integrations must report sync operations unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // No fabricated operational counts on a dead screen.
  expect(body).not.toContain("Connected patients");
});

test("the billing, checkout, and catalog surfaces stay honest with a down backend", async ({ page }) => {
  // PHASE 8A: money screens are the least forgiving place to guess. With the
  // backend down every one of them must refuse — never a zeroed summary (an
  // empty practice and an unreachable backend are different statements),
  // never a stock number, and never a payment control that would imply a
  // charge could be taken.
  await page.goto("/billing");
  await page.waitForLoadState("networkidle");
  let body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/billing with the backend down");
  expect(
    body,
    `/billing must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // A dead screen must not present a balance sheet of zeros.
  expect(body).not.toContain("$0.00");
  expect(body).not.toContain("Outstanding");
  expect(body).not.toContain("Record payment");

  await page.goto("/settings/catalog");
  await page.waitForLoadState("networkidle");
  body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/settings/catalog with the backend down");
  expect(
    body,
    `/settings/catalog must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // No invented shelf: no stock counts and no receive control.
  expect(body).not.toContain("Receive");
  expect(body).not.toContain("on hand");

  await page.goto("/patients/11111111-2222-3333-4444-555555555555/billing");
  await page.waitForLoadState("networkidle");
  body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "the patient billing tab with the backend down");
  expect(
    body,
    `the patient billing tab must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // "No invoices yet" would be a claim about this patient's finances.
  expect(body).not.toContain("No invoices yet");
  expect(body).not.toContain("Account credit");
});

test("the plans, reconciliation, and reporting surfaces stay honest with a down backend", async ({ page }) => {
  // PHASE 8B: these screens describe money and entitlements. With the backend
  // down they must refuse — never an empty plan list (which would read as "we
  // sell nothing"), never a zeroed report, never a credit balance, and never a
  // control that implies care could be given away.
  await page.goto("/settings/plans");
  await page.waitForLoadState("networkidle");
  let body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/settings/plans with the backend down");
  expect(
    body,
    `/settings/plans must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // "No packages yet" would be a claim about what this practice sells.
  expect(body).not.toContain("No packages yet");
  expect(body).not.toContain("Assign complimentary");

  await page.goto("/billing/reconciliation");
  await page.waitForLoadState("networkidle");
  body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/billing/reconciliation with the backend down");
  expect(
    body,
    `/billing/reconciliation must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // A dead screen must not claim the books reconcile.
  expect(body).not.toContain("Nothing to reconcile");
  expect(body).not.toContain("Open exceptions");

  await page.goto("/billing/reports");
  await page.waitForLoadState("networkidle");
  body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/billing/reports with the backend down");
  expect(
    body,
    `/billing/reports must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // No balance sheet of zeros.
  expect(body).not.toContain("$0.00");
  expect(body).not.toContain("Gross charges");

  await page.goto("/patients/11111111-2222-3333-4444-555555555555/plans");
  await page.waitForLoadState("networkidle");
  body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "the patient plans tab with the backend down");
  expect(
    body,
    `the patient plans tab must report itself unavailable. Got:\n${body.slice(0, 600)}`,
  ).toMatch(HONEST_FAILURE);
  // "No credits" would be a claim about this patient's entitlements.
  expect(body).not.toContain("No credits");
  expect(body).not.toContain("Credits available");
});

test("the product catalog and template surfaces stay honest with a down backend", async ({
  page,
}) => {
  // PHASE 9B: both surfaces have an honest EMPTY state and an honest FAILURE
  // state, and they must not be the same words. "No governed products yet" is
  // a claim about the registry; with the backend down it is a claim nobody is
  // in a position to make.
  //
  // Asserted on the error element rather than a one-shot `innerText` read:
  // the load is client-side, so reading the body once races the request and
  // can catch the panel mid-flight.
  await page.goto("/settings/knowledge");
  await page.getByRole("tab", { name: "Product catalog" }).click();

  await expect(page.getByTestId("catalog-error")).toContainText(HONEST_FAILURE);
  let body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/settings/knowledge catalog with the backend down");
  // The empty-state copy must NOT appear: it would assert an empty registry.
  expect(body).not.toContain("No governed products yet");
  expect(body).not.toContain("Nothing is waiting for review");

  await page.getByRole("tab", { name: "Protocol templates" }).click();

  await expect(page.getByTestId("template-error")).toContainText(HONEST_FAILURE);
  body = (await page.locator("body").innerText()).trim();
  await expectNoFixtureData(body, "/settings/knowledge templates with the backend down");
  expect(body).not.toContain("No protocol templates yet");
});

test("settings reports the clinical edition and its real configuration state", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  const body = (await page.locator("body").innerText()).trim();
  // The operator must be able to see which edition this is.
  expect(body).not.toContain("Interactive demo — synthetic data only");
  await expectNoFixtureData(body, "/settings in the clinical edition");
});
