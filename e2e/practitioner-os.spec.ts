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

test("Clinical Knowledge Center versions and approves governed pathways", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/settings/knowledge");
  await expect(page.getByRole("heading", { name: "Clinical Knowledge Center" })).toBeVisible();
  await expect(page.getByText("6 governed pathways")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Thyroid classification pathway" })).toBeVisible();
  await expect(page.getByText("Full Thyroid Panel", { exact: true })).toBeVisible();
  await expect(page.getByText("Thyro Immune", { exact: true })).toBeVisible();
  await expect(page.getByText("Exact current label must be verified before patient selection").first()).toBeVisible();

  await page.getByRole("button", { name: "New version" }).click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
  await page.getByLabel("Differentiating questions, one per line").fill(
    "Are thyroid antibodies documented?\nIs thyroid medication reconciled?\nWhen is thyroid medication taken relative to food?",
  );
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("approved content becomes immutable");
  await page.getByRole("button", { name: "Approve version" }).click();
  await expect(page.getByRole("combobox", { name: "Pathway version" })).toHaveValue("kp-thyroid-v2");
  await expect(page.getByRole("button", { name: "New version" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Clinical Knowledge Center stages the authoring pack and keeps review gates separate", async ({ page }) => {
  await page.goto("/settings/knowledge");
  await page.getByRole("tab", { name: "Import review" }).click();
  await page.getByRole("button", { name: "Load authoring pack" }).click();

  await expect(page.getByText("27", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("133", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("160", { exact: true }).first()).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Stage for review" }).click();

  await expect(page.getByText("27", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("133", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Import staged for practitioner review. Nothing was approved or verified.")).toBeVisible();

  await page.getByLabel("Import item type").selectOption("product_label");
  await expect(page.getByText("Source correction needed").first()).toBeVisible();
  await expect(page.getByTitle("Resolve source errors before accepting").first()).toBeDisabled();

  await page.getByLabel("Import item type").selectOption("pathway");
  const firstReady = page.locator("tbody tr").filter({ hasText: "Ready for review" }).first();
  await firstReady.getByTitle("Accept into draft review").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Accept as draft" }).click();
  await expect(page.getByText("Item applied as a non-approved draft. Separate approval or label verification is still required.")).toBeVisible();

  await page.getByRole("tab", { name: "Pathways" }).click();
  await expect(page.getByText("7 governed pathways")).toBeVisible();
});

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
    [`/patients/${PATIENT}/care-plan?view=supplements`, `/patients/${PATIENT}/supplements`],
    [`/patients/${PATIENT}/protocols`, `/patients/${PATIENT}/protocol`],
    [`/patients/${PATIENT}/lab-orders`, `/patients/${PATIENT}/labs?view=orders`],
    [`/patients/${PATIENT}/reports`, `/patients/${PATIENT}/files`],
    ["/wearables", `/patients/${PATIENT}/tracking?view=wearables`],
    ["/quantum-mind", `/patients/${PATIENT}/tracking?view=mind`],
    ["/nutrition", `/patients/${PATIENT}/nutrition`],
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

test("Today: patient name and Chart action open the complete patient record", async ({ page }) => {
  await page.goto("/today");
  const patientLinks = page.getByRole("link", { name: /Open full patient record for/ });
  const patientFiles = page.getByRole("link", { name: "Patient file" });
  const patientCount = await patientLinks.count();
  expect(patientCount).toBeGreaterThan(0);
  await expect(patientFiles).toHaveCount(patientCount);
  // The schedule (and therefore the first row's patient) rotates with the
  // real weekday, so assert what every linked patient guarantees: the link
  // opens that patient's consolidated record with the full tab system.
  const patientLink = patientLinks.first();
  const patientName = await patientLink.textContent();
  await patientLink.click();
  await expect(page).toHaveURL(/\/patients\/[^/]+\/overview$/);
  await expect(page.getByRole("heading", { name: patientName?.trim() ?? "" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Patient profile & practice details" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Chart & Timeline" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Protocol" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Nutrition" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Supplements" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Patients" })).toHaveAttribute("aria-current", "page");

  // The concise clinical strip is curated data — assert it on the flagship
  // record, which carries the complete handoff dataset every weekday.
  await page.goto("/patients/p-78435/overview");
  await expect(page.getByRole("heading", { name: "Clinical overview" })).toBeVisible();
  await expect(page.getByText("Health score", { exact: true })).toBeVisible();
  await expect(page.getByText("Recent labs & biomarkers", { exact: true })).toBeVisible();
  await expect(page.getByText("Wearables & recovery", { exact: true })).toBeVisible();
  await expect(page.getByText("Active plan & experiments", { exact: true })).toBeVisible();
});

test("Today: a newly linked schedule patient opens the matching patient file", async ({ page }) => {
  await page.goto("/today");
  // Which newly linked (p-805xx) patients appear rotates with the real
  // weekday; every weekday schedules at least one. Whichever renders first
  // must open its own patient file — these names used to dead-end.
  const derivedLink = page
    .getByRole("link", { name: /Open full patient record for/ })
    .and(page.locator('a[href^="/patients/p-805"]'))
    .first();
  await expect(derivedLink).toBeVisible();
  const patientName = (await derivedLink.textContent())?.trim() ?? "";
  const href = await derivedLink.getAttribute("href");
  await derivedLink.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("heading", { name: patientName, level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Patients" })).toHaveAttribute("aria-current", "page");
});

test("Today: active program users link to their own patient overview", async ({ page }) => {
  await page.goto("/today");
  const programs = page.getByTestId("today-programs");
  await expect(programs.getByText("Programs & active users")).toBeVisible();
  await expect(programs.getByText("Metabolic Reset — 12-Week Program")).toBeVisible();
  await expect(programs.getByText("Sleep Foundations Mini-Course")).toBeVisible();

  const expectedLinks = [
    ["Alexandra Morgan", "/patients/p-78435/overview"],
    ["Dana Whitfield", "/patients/p-66473/overview"],
    ["Michael Johnson", "/patients/p-64201/overview"],
    ["Jessica Parker", "/patients/p-71126/overview"],
    ["Priya Sharma", "/patients/p-59318/overview"],
  ];
  for (const [name, href] of expectedLinks) {
    await expect(programs.getByRole("link", { name: `Open patient overview for ${name}` })).toHaveAttribute("href", href);
  }

  await programs.getByRole("link", { name: "Open patient overview for Dana Whitfield" }).click();
  await expect(page).toHaveURL(/\/patients\/p-66473\/overview$/);
  await expect(page.getByRole("heading", { name: "Dana Whitfield", level: 1 })).toBeVisible();
});

test("AI-aware Today brief exposes sources and records practitioner review", async ({ page }) => {
  await page.goto("/today");
  const brief = page.getByTestId("today-ai-brief");

  await expect(brief.getByRole("heading", { name: "AI daily brief" })).toBeVisible();
  await expect(brief.getByText("Deterministic demo assistant")).toBeVisible();
  await expect(brief.getByText("Awaiting review")).toBeVisible();
  await brief.getByText(/Sources used/).click();
  await expect(brief.getByText("Review queue").first()).toBeVisible();

  await brief.getByRole("button", { name: /Mark reviewed/ }).click();
  await expect(brief.getByText("Reviewed this session")).toBeVisible();
  await expect(brief.getByText("Review recorded")).toBeVisible();
});

test("AI-aware Inbox triage drafts a reply but preserves the patient-facing review gate", async ({ page }) => {
  await page.goto("/inbox?thread=th-priya-labs");
  const assist = page.getByTestId("inbox-assist:th-priya-labs");

  await expect(assist.getByRole("heading", { name: "AI thread assist" })).toBeVisible();
  await expect(assist.getByText("Review now", { exact: true }).first()).toBeVisible();
  await expect(assist.getByText(/not a diagnosis or medical probability/)).toBeVisible();
  await assist.getByRole("button", { name: "Use reply draft" }).click();

  const reply = page.getByLabel("Reply");
  await expect(reply).toHaveValue(/Worsening fatigue and becoming winded/);
  await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
  await page.getByLabel("I reviewed this patient-facing content").check();
  await expect(page.getByRole("button", { name: "Send reply" })).toBeEnabled();
});

test("patient longitudinal AI brief opens an editable note draft without writing to the chart", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/overview`);
  const brief = page.getByTestId(`patient-change-brief:${PATIENT}`);

  await expect(brief.getByRole("heading", { name: "What changed since last visit" })).toBeVisible();
  await expect(brief.getByText("Labs and biomarkers").first()).toBeVisible();
  await brief.getByRole("button", { name: "Add to note draft" }).click();

  const composer = page.getByRole("dialog", { name: "Note and report composer" });
  await expect(composer).toBeVisible();
  await expect(composer.getByText("Draft — not final")).toBeVisible();
  await expect(composer.getByText("AI-drafted · requires practitioner review")).toBeVisible();
});

test("patient picker: search by name and preserve the active patient tab", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/chart`);
  await page.getByRole("button", { name: "Switch patient" }).click();
  const picker = page.getByRole("dialog", { name: "Switch patient" });
  await picker.getByLabel("Search patients").fill("Marcus");
  await expect(picker.getByText("1 patient found")).toBeVisible();
  await expect(picker.getByRole("link", { name: /Marcus Webb/ })).toBeVisible();
  await expect(picker.getByRole("link", { name: /Alexandra Morgan/ })).toHaveCount(0);
  await picker.getByRole("link", { name: /Marcus Webb/ }).click();
  await expect(page).toHaveURL(`/patients/p-52984/chart`);
  await expect(page.getByRole("heading", { name: "Marcus Webb" })).toBeVisible();

  await page.getByRole("button", { name: "Switch patient" }).click();
  const emptyPicker = page.getByRole("dialog", { name: "Switch patient" });
  await emptyPicker.getByLabel("Search patients").fill("No Such Patient");
  await expect(emptyPicker.getByText("No patients found")).toBeVisible();
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

test("product catalog controls inventory and preserves invoice explanations", async ({ page }) => {
  const explanation = "Concentrated omega-3 selected for cardiovascular, brain, and healthy inflammatory-response support.";

  await page.goto("/settings");
  await page.getByRole("link", { name: /Products & inventory/ }).click();
  await expect(page.getByRole("heading", { name: "Products & inventory" }).first()).toBeVisible();

  const omegaRow = page.getByRole("row").filter({ hasText: "Omega-3 EPA/DHA" });
  await omegaRow.getByRole("button", { name: "Manage" }).click();
  const manage = page.getByRole("dialog", { name: /Manage · Omega-3 EPA\/DHA/ });
  await manage.getByLabel("Patient-facing invoice explanation").fill(explanation);
  await manage.getByRole("button", { name: "Save product details" }).click();

  await omegaRow.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("dialog", { name: /Manage · Omega-3 EPA\/DHA/ }).getByRole("button", { name: "Receive" }).click();

  await page.goto(`/billing?tab=checkout&patient=${PATIENT}`);
  await page.getByRole("button", { name: /Omega-3 EPA\/DHA/ }).click();
  await expect(page.getByText(explanation).first()).toBeVisible();
  await page.getByRole("button", { name: "Take payment (test mode)" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Record payment" }).click();
  const receipt = page.getByRole("dialog", { name: "Receipt" });
  await expect(receipt.getByText(explanation)).toBeVisible();
  await receipt.getByRole("button", { name: "Done" }).click();

  await page.goto(`/patients/${PATIENT}/billing`);
  await page.getByRole("button", { name: "Details" }).first().click();
  await expect(page.getByText(explanation)).toBeVisible();

  await page.goto("/settings/catalog");
  await page.getByPlaceholder("Search product, SKU, supplier, or category").fill("Omega-3");
  await expect(page.getByRole("row").filter({ hasText: "Omega-3 EPA/DHA" })).toContainText("16");
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
  await page.getByRole("tab", { name: "Full timeline" }).click();
  await expect(page.getByText("Follow-up note signed")).toBeVisible();
  await page.getByRole("button", { name: /^Labs \(\d+\)$/ }).click();
  await expect(page.getByText("Quest panel imported").first()).toBeVisible();
  await expect(page.getByText("Follow-up note signed")).toHaveCount(0);
  await page.getByRole("button", { name: /^All \(\d+\)$/ }).click();
  await page.getByLabel("Search timeline").fill("magnesium");
  await expect(page.getByText("Magnesium glycinate dispensed")).toBeVisible();
  await expect(page.getByText("Quest panel imported")).toHaveCount(0);
});

test("patient chart: create, autosave, copy forward, sign, and build a custom chart", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/chart`);
  await expect(page.getByRole("heading", { name: "Patient chart" })).toBeVisible();
  await expect(page.getByText("SOAP follow-up", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "New chart entry" }).click();
  const newEntry = page.getByRole("dialog", { name: "New chart entry" });
  await newEntry.getByRole("button", { name: /Functional medicine follow-up/ }).click();
  await newEntry.getByRole("button", { name: "Create draft" }).click();

  const editor = page.getByRole("dialog", { name: "Functional medicine follow-up" });
  await editor.getByLabel("Interval history and what changed *").fill("Energy improved after the timing change; sleep remains variable.");
  await editor.getByLabel("Clinical interpretation *").fill("Early response is favorable, with sleep consistency still limiting recovery.");
  await editor.getByLabel("Updated plan *").fill("Continue the current phase and review sleep consistency at the next visit.");
  await expect(editor.getByText("Autosaved · demo session")).toBeVisible();
  await editor.getByRole("button", { name: "Close", exact: true }).click();

  const draftCard = page.locator("div").filter({ hasText: /^Functional medicine follow-up/ }).first();
  await draftCard.getByRole("button", { name: /Duplicate Functional medicine follow-up forward/ }).click();
  const duplicate = page.getByRole("dialog", { name: "Duplicate forward" });
  await duplicate.getByRole("button", { name: "Create copied draft" }).click();
  const copiedEditor = page.getByRole("dialog", { name: "Functional medicine follow-up" });
  await expect(copiedEditor.getByText(/Copied forward from/)).toBeVisible();
  await copiedEditor.getByRole("button", { name: "Review and sign" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign chart entry" }).click();
  await expect(copiedEditor.getByText("Signed and locked.")).toBeVisible();
  await copiedEditor.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Templates" }).click();
  await page.getByRole("dialog", { name: "Chart templates" }).getByRole("button", { name: "Create custom chart" }).click();
  const builder = page.getByRole("dialog", { name: "Create custom chart" });
  await builder.getByLabel("Template name").fill("Biofeedback treatment follow-up");
  await builder.getByPlaceholder("Field label").fill("Treatment response");
  await builder.getByRole("button", { name: "Add field" }).click();
  const checkboxField = builder.getByTestId("chart-builder-field-2");
  await checkboxField.getByPlaceholder("Field label").fill("Modalities used");
  await checkboxField.getByLabel("Input type").selectOption("checkbox-group");
  await checkboxField.getByLabel("Choices (comma separated)").fill("Acupuncture, Cupping, Gua sha, Moxibustion");
  await builder.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByRole("dialog", { name: "Chart templates" }).getByText("Biofeedback treatment follow-up")).toBeVisible();
});

test("dynamic charting: sliders, checkbox groups, body-map points, and the scribe workflow", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/chart`);
  await page.getByRole("button", { name: "New chart entry" }).click();
  const newEntry = page.getByRole("dialog", { name: "New chart entry" });
  await newEntry.getByRole("button", { name: /Pain assessment & body map/ }).click();
  await newEntry.getByRole("button", { name: "Create draft" }).click();

  const editor = page.getByRole("dialog", { name: "Pain assessment & body map" });
  await editor.getByLabel("Primary pain area *").fill("Left posterior shoulder with upper-trapezius referral.");
  await editor.getByText("Sharp", { exact: true }).click();
  await editor.getByText("Tight", { exact: true }).click();
  await editor.getByLabel("Pain now").fill("7");
  await editor.getByRole("button", { name: "Pain point", exact: true }).click();
  await editor.getByLabel("Point label").fill("Left shoulder");
  const bodyMap = editor.getByRole("img", { name: "Interactive clinical body map" });
  await bodyMap.click({ position: { x: 315, y: 95 } });
  await expect(editor.getByText("1 pain point")).toBeVisible();
  await editor.getByText("Draw area", { exact: true }).click();
  const bodyMapBox = await bodyMap.boundingBox();
  expect(bodyMapBox).not.toBeNull();
  await page.mouse.move(bodyMapBox!.x + 180, bodyMapBox!.y + 90);
  await page.mouse.down();
  await page.mouse.move(bodyMapBox!.x + 210, bodyMapBox!.y + 105, { steps: 4 });
  await page.mouse.move(bodyMapBox!.x + 245, bodyMapBox!.y + 125, { steps: 4 });
  await page.mouse.up();
  await expect(editor.getByText("1 drawn area")).toBeVisible();
  await editor.getByLabel("Assessment and plan *").fill("Reassess range of motion and response after treatment; review red flags before signing.");
  await editor.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "AI Scribe" }).click();
  const scribe = page.getByRole("dialog", { name: "AI Scribe" });
  await expect(scribe.getByRole("button", { name: "Start recording" })).toBeDisabled();
  await scribe.getByRole("checkbox").check();
  await scribe.getByRole("button", { name: "Start recording" }).click();
  await expect(scribe.getByText("Recording visit")).toBeVisible();
  await scribe.getByRole("button", { name: "Stop & transcribe" }).click();
  await expect(scribe.getByLabel("Scribe transcript")).toHaveValue(/morning energy has improved/);
  await scribe.getByRole("button", { name: "Create practitioner-review draft" }).click();
  const scribeDraft = page.getByRole("dialog", { name: "SOAP follow-up" });
  await expect(scribeDraft.getByLabel("Subjective *")).toHaveValue(/morning energy has improved/);
  await expect(scribeDraft.getByText("Autosaved · demo session")).toBeVisible();
});

test("patient care tabs expose complete protocol, diet plan, and supplements directly", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/protocol`);
  await expect(page.getByRole("tab", { name: "Protocol" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Complete protocol" })).toBeVisible();
  await expect(page.getByText("Goals and success criteria")).toBeVisible();
  await expect(page.getByText("Safety review and stop criteria")).toBeVisible();
  await expect(page.getByText("Version and approval history")).toBeVisible();

  await page.getByRole("tab", { name: "Nutrition" }).click();
  await expect(page.getByRole("heading", { name: "Diet plan & nutrition" })).toBeVisible();
  await expect(page.getByText("Anti-inflammatory Mediterranean plan")).toBeVisible();
  await expect(page.getByText("Daily meal structure")).toBeVisible();

  await page.getByRole("tab", { name: "Supplements" }).click();
  await expect(page.getByRole("heading", { name: "Supplement Intelligence" })).toBeVisible();
  await expect(page.getByText("Current stack")).toBeVisible();
});

test("nutrition: select, customize, and approve a prebuilt diet plan", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/nutrition`);
  await page.getByRole("button", { name: "Diet plan library" }).click();

  const library = page.getByRole("dialog", { name: "Diet plan library" });
  await expect(library.getByText("Autoimmune Protocol (AIP) diet")).toBeVisible();
  await expect(library.getByText("GAPS diet educational template")).toBeVisible();
  await expect(library.getByText("Ketogenic diet", { exact: true })).toBeVisible();
  await library.getByRole("button", { name: /Low FODMAP 3-step plan/ }).click();
  await expect(library.getByText("Short restriction · structured reintroduction · personalization")).toBeVisible();
  await expect(library.getByText("Step 2 · Reintroduction")).toBeVisible();
  await expect(library.getByText("Monash University · 3-step FODMAP diet")).toBeVisible();
  await library.getByRole("button", { name: "Use Low FODMAP 3-step plan for Alexandra" }).click();

  await expect(page.getByRole("heading", { name: "Low FODMAP 3-step plan" })).toBeVisible();
  await expect(page.getByText("draft", { exact: true })).toBeVisible();
  await expect(page.getByText("How to follow it")).toBeVisible();
  await expect(page.getByText("Safety and suitability")).toBeVisible();

  await page.getByRole("button", { name: "Edit draft" }).click();
  const editor = page.getByRole("dialog").filter({ has: page.getByLabel("Plan name") });
  await editor.getByLabel("Patient explanation").fill("A patient-specific three-step trial with planned food reintroduction.");
  await editor.getByRole("button", { name: "Save diet plan draft" }).click();
  await expect(page.getByText("A patient-specific three-step trial with planned food reintroduction.")).toBeVisible();

  await page.getByRole("button", { name: "Approve plan" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve diet plan" }).click();
  await expect(page.getByText("Approved this session", { exact: true })).toBeVisible();
  await expect(page.getByText("active", { exact: true })).toBeVisible();
});

test("protocols: create from mold template, customize interventions, and save a reusable template", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/protocol`);
  await page.getByRole("button", { name: "New protocol" }).click();
  const create = page.getByRole("dialog", { name: "Create a patient protocol" });
  await expect(create.getByText("Mold / biotoxin support protocol")).toBeVisible();
  await create.getByRole("button", { name: "Use Mold / biotoxin support protocol for Alexandra" }).click();

  const editor = page.getByRole("dialog").filter({ has: page.getByLabel("Protocol name") });
  await editor.getByLabel("Protocol name").fill("Alexandra mold support protocol");
  const binder = editor.getByTestId("protocol-intervention-2");
  await binder.getByLabel("Intervention").fill("Patient-selected binder");
  await binder.getByLabel("Schedule / dose").fill("Patient-specific schedule after review");
  const herb = editor.getByTestId("protocol-intervention-4");
  await herb.getByLabel("Intervention").fill("Practitioner-selected herbal formula");
  await editor.getByRole("button", { name: "Save protocol draft" }).click();
  await expect(page.getByText("Alexandra mold support protocol").first()).toBeVisible();

  await page.getByRole("button", { name: "Save as template" }).click();
  const saveTemplate = page.getByRole("dialog", { name: "Save as practice template" });
  await saveTemplate.getByLabel("Template name").fill("Mold protocol — practice base");
  await saveTemplate.getByRole("button", { name: "Save template" }).click();

  await page.getByRole("button", { name: "Protocol templates" }).click();
  const library = page.getByRole("dialog", { name: "Protocol templates" });
  await expect(library.getByText("Mold protocol — practice base")).toBeVisible();
  await expect(library.getByText("Practice template", { exact: true })).toBeVisible();
});

test("governance lives under Settings and both tabs render", async ({ page }) => {
  await page.goto("/settings/governance?tab=ai");
  await expect(page.getByRole("heading", { name: "Security & Governance" })).toBeVisible();
  await page.goto("/settings/governance?tab=audit");
  await expect(page.getByRole("heading", { name: "Security & Governance" })).toBeVisible();
});

test("clinical copilot: adaptive intake creates reviewed lab and exact-product protocol drafts", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/labs?view=copilot`);
  await expect(page.getByRole("heading", { name: "Governed clinical copilot" })).toBeVisible();
  await expect(page.getByText("Affiliate links are intentionally hidden at this stage.")).toHaveCount(0);

  await page.getByRole("button", { name: "Fatigue" }).click();
  await page.getByLabel(/Any severe or rapidly worsening symptoms/).selectOption("no");
  await page.getByLabel(/current medication and supplement list reconciled/).selectOption("yes");
  await page.getByLabel(/allergies and prior adverse reactions confirmed/).selectOption("yes");
  await page.getByLabel(/pregnancy, nursing, pediatric/).selectOption("no");
  await page.getByLabel(/elevated thyroid antibodies/).selectOption("no");
  await page.getByLabel(/currently using thyroid medication/).selectOption("no");
  await page.getByRole("button", { name: "Build review draft" }).click();

  await expect(page.getByText("ThyroPep", { exact: true })).toBeVisible();
  await expect(page.getByText("Thyrotain", { exact: true })).toBeVisible();
  await expect(page.getByText("Affiliate links are intentionally hidden at this stage.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create protocol draft" })).toBeDisabled();

  await page.getByRole("button", { name: "Add to order draft" }).first().click();
  await page.getByText(/I verified the current exact product/).nth(0).click();
  await page.getByText(/I verified the current exact product/).nth(1).click();
  await page.getByRole("button", { name: "Mark output reviewed" }).click();
  await page.getByRole("button", { name: "Create protocol draft" }).click();
  await expect(page.getByRole("link", { name: "Open protocol draft" })).toBeVisible();

  await page.getByRole("link", { name: "Open protocol draft" }).click();
  await expect(page.getByRole("heading", { name: "Thyroid health review protocol draft" })).toBeVisible();
  await expect(page.getByText("ThyroPep · Integrative Peptides")).toBeVisible();
  await expect(page.getByText("Thyrotain · Ortho Molecular Products")).toBeVisible();
  await expect(page.getByText("Pending approval", { exact: true }).first()).toBeVisible();
});
