import { expect, test, type Page } from "@playwright/test";

/**
 * Practitioner-OS overhaul coverage (MOCK app): IA redirects, Today,
 * appointment drawer, checkout → ledger propagation, Inbox review-gated
 * send, Programs Studio + copilot approval gate, automations test mode,
 * template versioning, report role scope, chart timeline filters.
 */

const PATIENT = "p-78435";

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test.describe.configure({ mode: "serial" });

test("route consolidation: every old URL lands on its new home", async ({ page }) => {
  const cases: [string, string][] = [
    ["/practice", "/today"],
    ["/clients", "/patients"],
    ["/messages", "/inbox"],
    ["/automations", "/integrations?tab=automations"],
    ["/imports", "/settings/data?tab=imports"],
    ["/ai-safety", "/settings/governance?tab=ai"],
    ["/audit-log", "/settings/governance?tab=audit"],
    ["/claims", "/billing?tab=claims"],
    ["/assessments", "/templates?type=assessment"],
    [`/patients/${PATIENT}/summary`, `/patients/${PATIENT}/overview`],
    [`/patients/${PATIENT}/timeline`, `/patients/${PATIENT}/chart`],
    [`/patients/${PATIENT}/twin`, `/patients/${PATIENT}/tracking?view=twin`],
    [`/patients/${PATIENT}/nof1-lab`, `/patients/${PATIENT}/tracking?view=experiments`],
    [`/patients/${PATIENT}/reasoning`, `/patients/${PATIENT}/labs?view=reasoning`],
    [`/patients/${PATIENT}/supplements`, `/patients/${PATIENT}/care-plan?view=supplements`],
    [`/patients/${PATIENT}/protocols`, `/patients/${PATIENT}/care-plan`],
    [`/patients/${PATIENT}/lab-orders`, `/patients/${PATIENT}/labs?view=orders`],
    [`/patients/${PATIENT}/reports`, `/patients/${PATIENT}/files`],
    ["/wearables", `/patients/${PATIENT}/tracking?view=wearables`],
    ["/quantum-mind", `/patients/${PATIENT}/tracking?view=mind`],
    ["/nutrition", `/patients/${PATIENT}/care-plan?view=nutrition`],
  ];
  for (const [from, to] of cases) {
    await page.goto(from);
    await page.waitForURL(`**${to}`);
  }
});

test("Today: daily brief renders and front-desk arrival updates the schedule", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Unread patient messages")).toBeVisible();
  await expect(page.getByText("Needs attention today")).toBeVisible();
  await expect(page.getByText("Failed syncs")).toBeVisible();

  // Arrive the first schedule row; the status chip replaces the button.
  const arrive = page.getByRole("button", { name: "Arrive" }).first();
  await arrive.click();
  await expect(page.getByText(/Arrived recorded for/).first()).toBeVisible();
  await expect(page.getByText("Arrived", { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("calendar deep link opens the appointment drawer with front-desk actions", async ({ page }) => {
  await page.goto("/calendar?appt=appt-1");
  const drawer = page.getByRole("dialog", { name: "Appointment details" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Michael Johnson").first()).toBeVisible();
  await expect(drawer.getByText(/Visit fee/)).toBeVisible();
  await expect(drawer.getByText(/Balance/)).toBeVisible();

  await drawer.getByRole("button", { name: "Arrive" }).click();
  await drawer.getByRole("button", { name: "Check in" }).click();
  await expect(drawer.getByText("Checked in").first()).toBeVisible();

  // No-show requires an explicit confirmation and then reflects on the grid.
  await page.goto("/calendar?appt=appt-2");
  const drawer2 = page.getByRole("dialog", { name: "Appointment details" });
  await drawer2.getByRole("button", { name: "No show" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Mark no-show" }).click();
});

test("checkout records an invoice that shows up across billing surfaces", async ({ page }) => {
  await page.goto(`/billing?tab=checkout&patient=${PATIENT}`);
  await expect(page.getByText("Stripe test-mode UI — no payment submitted").first()).toBeVisible();

  await page.getByRole("button", { name: /Follow-up visit \(30 min\)/ }).first().click();
  await page.getByRole("button", { name: /Magnesium Glycinate/ }).first().click();
  await page.getByRole("button", { name: "Take payment (test mode)" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Record payment" })
    .click();

  const receipt = page.getByRole("dialog", { name: "Receipt" });
  await expect(receipt).toBeVisible();
  await expect(receipt.getByText(/Invoice #\d+/)).toBeVisible();
  await receipt.getByRole("button", { name: "Done" }).click();

  // Patient ledger reflects the session invoice.
  await page.goto(`/patients/${PATIENT}/billing`);
  await expect(page.getByText("· this session").first()).toBeVisible();

  // The billing-summary report (live demo ledger) includes collected money.
  await page.goto("/reports");
  await page.getByRole("button", { name: "Billing summary" }).click();
  await expect(page.getByText("Collected", { exact: true })).toBeVisible();
});

test("inbox: review-gated demo send, internal note, and task creation", async ({ page }) => {
  await page.goto("/inbox?thread=th-avery-timing");
  await expect(page.getByText("Evening supplement timing").first()).toBeVisible();

  // Patient-facing send is disabled until the review box is checked.
  const replyBox = page.getByLabel("Reply");
  await replyBox.fill("Take it about an hour before bed — dinner timing blunts absorption.");
  const send = page.getByRole("button", { name: "Send reply" });
  await expect(send).toBeDisabled();
  await page.getByText("I reviewed this patient-facing content").click();
  await send.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Send (demo)" }).click();
  await expect(page.getByText("Demo send — not delivered").first()).toBeVisible();

  // Internal note renders with the internal banner, never patient-visible.
  await page.getByRole("checkbox", { name: "Internal note" }).check();
  await page
    .getByRole("textbox", { name: "Internal note" })
    .fill("Confirm dose at next visit.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Internal — never visible to patient").first()).toBeVisible();

  // Create a task from the thread; it lands in the review queue.
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.goto("/tasks");
  await expect(page.getByText("Inbox follow-up: Evening supplement timing")).toBeVisible();
});

test("programs studio: reorder, copilot draft → approve → publish gate", async ({ page }) => {
  await page.goto("/programs");
  await expect(page.getByRole("heading", { name: "Programs Studio" })).toBeVisible();

  // Copilot: generate an AI draft; it must be labeled and approval-gated.
  await page.getByRole("button", { name: "AI Program Copilot" }).click();
  await page.getByRole("button", { name: /Generate draft/ }).click();
  await expect(page.getByText(/AI draft v\d+ — practitioner approval required/)).toBeVisible();
  await expect(page.getByText("AI DRAFT — review before use", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Open in builder" }).click();
  await expect(page.getByText("AI draft — approval required")).toBeVisible();

  // Publish is blocked until the practitioner approves the draft.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByText("AI-drafted content must be practitioner-approved before publishing.").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve AI draft" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("published", { exact: true }).first()).toBeVisible();

  // Curriculum reorder via accessible buttons.
  const moveDown = page.getByRole("button", { name: /^Move .* down$/ }).first();
  await moveDown.click();
  await expect(page.getByText(/reordered/).first()).toBeVisible();
});

test("integrations: automation test mode is side-effect free and review-gated", async ({ page }) => {
  await page.goto("/integrations?tab=automations");
  const noShowCard = page
    .locator("div")
    .filter({ hasText: /^No-show → follow-up/ })
    .first();
  await page.getByRole("button", { name: "Test run" }).nth(1).click();
  await expect(page.getByText(/Test run blocked \(review gate\)/).first()).toBeVisible();
  await expect(page.getByText("TEST MODE — no real trigger, synthetic context only").first()).toBeVisible();
  await expect(noShowCard.getByText(/Action HELD at review gate/).first()).toBeVisible();

  await page.goto("/integrations?tab=sync-log");
  await expect(page.getByText("failed", { exact: true }).first()).toBeVisible();

  await page.goto("/integrations");
  await expect(page.getByText("Sandbox (simulated)").first()).toBeVisible();
  await expect(page.getByText("Not connected").first()).toBeVisible();
});

test("template library: contextual filter + versioned save", async ({ page }) => {
  await page.goto("/templates?type=protocol");
  await expect(page.getByText("Iron repletion protocol").first()).toBeVisible();
  await page.getByRole("button", { name: "Iron repletion protocol" }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("Template body").fill("Phase 1 (weeks 1–4): updated dosing note…");
  await drawer.getByLabel("Version note").fill("Adjusted dosing note");
  await drawer.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByText(/Saved as version 4/).first()).toBeVisible();
});

test("reports: role scope hides owner-only reports in the UI", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("button", { name: "A/R aging" })).toBeVisible();
  await page.getByLabel("Report role scope").selectOption("Front desk");
  await expect(page.getByRole("button", { name: "A/R aging" })).toHaveCount(0);
  await expect(page.getByText(/reports? hidden for the Front desk role/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Transactions" })).toBeVisible();
});

test("chart timeline: kind filters and search narrow the longitudinal record", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/chart`);
  await expect(page.getByText("Follow-up note signed")).toBeVisible();
  await page.getByRole("button", { name: /^Labs \(\d+\)$/ }).click();
  await expect(page.getByText("Quest panel imported").first()).toBeVisible();
  await expect(page.getByText("Follow-up note signed")).toHaveCount(0);
  await page.getByRole("button", { name: /^All \(\d+\)$/ }).click();
  await page.getByLabel("Search timeline").fill("magnesium");
  await expect(page.getByText("Magnesium glycinate dispensed")).toBeVisible();
  await expect(page.getByText("Quest panel imported")).toHaveCount(0);
});

test("governance lives under Settings and both tabs render", async ({ page }) => {
  await page.goto("/settings/governance?tab=ai");
  await expect(page.getByRole("heading", { name: "Security & Governance" })).toBeVisible();
  await page.goto("/settings/governance?tab=audit");
  await expect(page.getByRole("heading", { name: "Security & Governance" })).toBeVisible();
});
