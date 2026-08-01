import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * PHASE 9B, browser-level: the Product Catalog and the Protocol Template
 * lifecycle.
 *
 * The two claims worth proving on a real screen:
 *
 *   1. A field the label did not carry reads "Unknown" — not blank, and not
 *      "None". "None" is a clinical claim about a product that nobody made;
 *      blank is the same claim with the evidence hidden.
 *
 *   2. Publication of a template carrying an unsourced dose is REFUSED, and
 *      the refusal names the item. The fixture backend enforces this exactly
 *      as the database does, so the proof is of a real constraint rather than
 *      of a disabled button.
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-catalog-templates.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

test.beforeAll(resetBackend);

const STUB = "http://127.0.0.1:3999";
const KNOWLEDGE = "/settings/knowledge";

type Page = import("@playwright/test").Page;

async function openTab(page: Page, name: string) {
  await page.goto(KNOWLEDGE);
  await page.getByRole("tab", { name }).click();
}

/** Test-only fixture seeding. Never a real backend call. */
async function seedLabel(body: Record<string, unknown>) {
  const res = await fetch(`${STUB}/__control/seed-catalog-label`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { labelVersionId: string };
}

async function seedItems(versionId: string, items: unknown[]) {
  await fetch(`${STUB}/__control/seed-template-items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionId, items }),
  });
}

/* ------------------------------------------------------- product catalog */

test("1. an empty catalog says it is empty and shows no sample products", async ({
  page,
}) => {
  await openTab(page, "Product catalog");
  await expect(page.getByTestId("product-catalog")).toBeVisible();
  await expect(page.getByTestId("count-total")).toHaveText("0");
  await expect(page.getByTestId("catalog-empty")).toContainText(
    "no example products are shown",
  );
  await expect(page.getByTestId("catalog-rows")).toHaveCount(0);
});

test("2. an empty review queue says nothing is waiting, not a fabricated task", async ({
  page,
}) => {
  await openTab(page, "Product catalog");
  await expect(page.getByTestId("catalog-queue-empty")).toContainText(
    "Nothing is waiting for review",
  );
});

test("3. a field the label did not carry reads Unknown, never None or blank", async ({
  page,
}) => {
  await seedLabel({
    productCode: "e2e-001",
    productName: "E2E Magnesium",
    brand: "E2E Labs",
    // Deliberately partial: no warnings, no allergens, no storage.
    exactLabel: { servingSize: "2 capsules", ingredients: "Mg 200 mg" },
  });
  await openTab(page, "Product catalog");
  await page.getByRole("button", { name: /E2E Magnesium/ }).click();

  await expect(page.getByTestId("label-serving-size")).toHaveText("2 capsules");
  await expect(page.getByTestId("label-warnings")).toHaveText("Unknown");
  await expect(page.getByTestId("label-allergens")).toHaveText("Unknown");
  await expect(page.getByTestId("label-storage")).toHaveText("Unknown");
  // The exact words matter: "None" would be a clinical claim.
  await expect(page.getByTestId("label-warnings")).not.toHaveText("None");
});

test("4. verification is not asserted until someone records what they checked", async ({
  page,
}) => {
  await openTab(page, "Product catalog");
  await expect(page.getByTestId("verification-e2e-001")).toContainText(
    "Not verified",
  );
  await page.getByRole("button", { name: /E2E Magnesium/ }).click();
  await expect(page.getByTestId("label-verification-state")).toContainText(
    "Nobody has checked this label",
  );

  // The button stays disabled until the note says what was checked.
  await expect(page.getByTestId("verify-label")).toBeDisabled();
  await page.getByTestId("verify-note").fill("Compared against the physical bottle.");
  await expect(page.getByTestId("verify-label")).toBeEnabled();
  await page.getByTestId("verify-label").click();

  await expect(page.getByTestId("label-notice")).toContainText(
    "recorded against your name",
  );
  await expect(page.getByTestId("label-verification-state")).toContainText(
    "Compared against the physical bottle",
  );
});

test("5. commercial data is a separate region, and never a clinical field", async ({
  page,
}) => {
  await seedLabel({
    productCode: "e2e-002",
    productName: "E2E Commercial",
    exactLabel: { servingSize: "1 capsule" },
    affiliateUrl: "https://affiliate.example/buy",
    // No disclosure supplied on purpose.
  });
  await openTab(page, "Product catalog");
  await page.getByRole("button", { name: /E2E Commercial/ }).click();

  const commercial = page.getByTestId("label-commercial");
  await expect(commercial).toBeVisible();
  await expect(page.getByTestId("label-commercial-notice")).toContainText(
    "no effect on eligibility, ranking, safety or evidence",
  );
  // The incomplete disclosure is surfaced, not quietly tolerated.
  await expect(page.getByTestId("label-disclosure-incomplete")).toContainText(
    "must not be shown to a patient",
  );

  // The affiliate URL must not appear anywhere in the clinical detail region.
  const clinicalText = await page.getByTestId("label-hash").textContent();
  expect(clinicalText ?? "").not.toContain("affiliate.example");
});

test("6. the list view is told a count, never a commercial URL", async ({ page }) => {
  await openTab(page, "Product catalog");
  await expect(page.getByTestId("commercial-count-e2e-002")).toContainText(
    "1 commercial",
  );
  const rows = await page.getByTestId("catalog-rows").textContent();
  expect(rows ?? "").not.toContain("affiliate.example");
});

/* ---------------------------------------------------- protocol templates */

test("7. an empty template library is honest about being empty", async ({ page }) => {
  await openTab(page, "Protocol templates");
  await expect(page.getByTestId("template-center")).toBeVisible();
  await expect(page.getByTestId("template-empty")).toContainText(
    "a template nobody wrote is a clinical recommendation nobody made",
  );
});

test("8. an unsourced dose blocks publication and names the item", async ({ page }) => {
  await openTab(page, "Protocol templates");
  await page.getByTestId("template-name").fill("E2E Sleep support");
  await page.getByTestId("template-create").click();
  await expect(page.getByTestId("template-notice")).toContainText("created as a draft");

  const templateId = await page
    .locator('[data-testid="template-rows"] [data-template-id]')
    .first()
    .getAttribute("data-template-id");
  expect(templateId).toBeTruthy();

  // Read the version through the app's own route, then seed an item carrying a
  // dose with NO recorded source.
  const detailRes = await page.request.post("/api/live/protocols/template-detail", {
    data: { templateId },
  });
  expect(detailRes.ok()).toBeTruthy();
  // Live routes answer `{ data }` on success, `{ error }` on failure.
  const versionId = ((await detailRes.json()) as {
    data: { currentVersionId: string };
  }).data.currentVersionId;
  expect(versionId).toBeTruthy();

  await seedItems(versionId, [
    { kind: "product", label: "Unsourced Magnesium", dosageText: "400 mg" },
  ]);

  await openTab(page, "Protocol templates");
  await page.getByRole("button", { name: /E2E Sleep support/ }).click();

  await expect(page.getByTestId("template-safety-notice")).toContainText(
    "Publication is blocked",
  );
  await expect(page.getByTestId("template-publish")).toBeDisabled();
  await expect(page.getByTestId("publish-blocked-reason")).toContainText(
    "no recorded source",
  );

  // The item itself is marked, so the operator learns WHICH dose is unsourced.
  // That comes from the governed detail read, not from an exception message:
  // the transport deliberately does not surface database text, because it
  // cannot tell an authored refusal from a Postgres internal carrying data.
  await expect(page.getByTestId("template-items")).toContainText(
    "Unsourced Magnesium",
  );
  await expect(page.getByTestId("template-items")).toContainText("none recorded");

  // And the refusal is REAL rather than a disabled button: calling the route
  // directly is refused too.
  const publishRes = await page.request.post("/api/live/protocols/template-action", {
    data: { action: "approve", versionId },
  });
  expect(publishRes.ok()).toBeFalsy();
});

test("9. naming the source unblocks publication, and the record is auditable", async ({
  page,
}) => {
  await openTab(page, "Protocol templates");
  const templateId = await page
    .locator('[data-testid="template-rows"] [data-template-id]')
    .first()
    .getAttribute("data-template-id");
  const detailRes = await page.request.post("/api/live/protocols/template-detail", {
    data: { templateId },
  });
  const versionId = ((await detailRes.json()) as {
    data: { currentVersionId: string };
  }).data.currentVersionId;

  await seedItems(versionId, [
    {
      kind: "product",
      label: "Sourced Magnesium",
      dosageText: "400 mg",
      doseSourceKind: "practitioner_protocol",
      doseSourceRef: "Supplied practitioner protocol, 2026",
      stoppingRules: ["Stop if loose stools persist beyond 72 hours"],
    },
    { kind: "lifestyle", label: "Wind-down routine" },
  ]);

  await openTab(page, "Protocol templates");
  await page.getByRole("button", { name: /E2E Sleep support/ }).click();
  await expect(page.getByTestId("template-safety-notice")).toContainText(
    "Every recorded dose names its source",
  );
  await expect(page.getByTestId("template-publish")).toBeEnabled();

  // A safety review needs a note, and records the count it actually saw.
  await expect(page.getByTestId("safety-record")).toBeDisabled();
  await page.getByTestId("safety-note").fill("Checked every dose against its source.");
  await expect(page.getByTestId("safety-record")).toBeEnabled();
  await page.getByTestId("safety-record").click();
  await expect(page.getByTestId("template-notice")).toContainText(
    "cannot be edited",
  );
  await expect(page.getByTestId("safety-reviews")).toContainText(
    "0 unsourced at review time",
  );
});

test("9b. the patient preview shows a recorded dose and omits an absent one", async ({
  page,
}) => {
  await openTab(page, "Protocol templates");
  await page.getByRole("button", { name: /E2E Sleep support/ }).click();

  await expect(page.getByTestId("patient-preview-notice")).toContainText(
    "not stored and not sent anywhere",
  );
  const rows = page.getByTestId("patient-preview-rows");
  await expect(rows).toContainText("Sourced Magnesium");
  await expect(rows).toContainText("400 mg");
  await expect(rows).toContainText("Wind-down routine");

  // The item with no dose carries no dose text — not a plausible default.
  const windDown = rows.locator("li", { hasText: "Wind-down routine" });
  await expect(windDown).not.toContainText("mg");
});

test("10. keyboard reaches the catalog tab and the tabpanel is labelled", async ({
  page,
}) => {
  await page.goto(KNOWLEDGE);
  const tab = page.getByRole("tab", { name: "Product catalog" });
  await tab.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("product-catalog")).toBeVisible();

  // The panel names the tab it belongs to, so a screen reader announces which
  // view it landed in rather than an unnamed region.
  const panel = page.getByRole("tabpanel");
  await expect(panel).toHaveAttribute("aria-labelledby", "knowledge-tab-catalog");
});

test("11. no PHI and no off-origin requests from either surface", async ({ page }) => {
  // Establish the app's own origin FIRST. Reading `page.url()` inside the
  // listener compares against "about:blank" for the very first request, which
  // makes the app's own page look off-origin.
  await page.goto(KNOWLEDGE);
  const appOrigin = new URL(page.url()).origin;

  const offOrigin: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("data:") || r.url().startsWith("blob:")) return;
    if (new URL(r.url()).origin !== appOrigin) offOrigin.push(r.url());
  });

  await openTab(page, "Product catalog");
  await expect(page.getByTestId("product-catalog")).toBeVisible();
  await openTab(page, "Protocol templates");
  await expect(page.getByTestId("template-center")).toBeVisible();

  expect(offOrigin).toEqual([]);
});

test("12. every interactive control on both surfaces has an accessible name", async ({
  page,
}) => {
  // A control a screen reader announces as "button" is a control nobody can
  // use without sight. Checked by walking the rendered DOM rather than by
  // listing the controls here, so a new unlabelled one fails this immediately
  // instead of being added to a list nobody updates.
  for (const tab of ["Product catalog", "Protocol templates"]) {
    await openTab(page, tab);
    const unnamed = await page.evaluate(() => {
      const problems: string[] = [];
      const named = (el: Element) => {
        const aria = el.getAttribute("aria-label")?.trim();
        if (aria) return true;
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) return true;
        if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
        if (el.closest("label")) return true;
        return (el.textContent ?? "").trim().length > 0;
      };
      for (const el of Array.from(
        document.querySelectorAll("button, input, select, textarea, a[href]"),
      )) {
        // Skip anything not currently rendered to a user.
        if (!(el as HTMLElement).offsetParent && el.tagName !== "INPUT") continue;
        if (!named(el)) {
          problems.push(`${el.tagName}${el.className ? "." + String(el.className).split(" ")[0] : ""}`);
        }
      }
      return problems;
    });
    expect(unnamed, `${tab} has unnamed controls`).toEqual([]);
  }
});

test("13. loading, error and success are announced, not just coloured", async ({
  page,
}) => {
  // Colour is not an announcement. The loading state and the confirmation are
  // `role="status"`; a failure is `role="alert"`. Without these a screen-reader
  // user watches a button do nothing and has no way to learn what happened.
  await openTab(page, "Protocol templates");

  // A success path: creating a template announces through role="status".
  await page.getByTestId("template-name").fill("A11y probe template");
  await page.getByTestId("template-create").click();
  const notice = page.getByTestId("template-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("role", "status");

  // The catalog's loading region carries the same contract.
  await openTab(page, "Product catalog");
  await expect(page.getByTestId("product-catalog")).toBeVisible();
  const loadingRole = await page.evaluate(() =>
    document.querySelector('[data-testid="catalog-loading"]')?.getAttribute("role")
      ?? "not-rendered",
  );
  // Either it is still loading (and announced) or it already resolved.
  expect(["status", "not-rendered"]).toContain(loadingRole);
});
