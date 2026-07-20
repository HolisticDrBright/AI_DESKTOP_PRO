import { expect, test } from "@playwright/test";

/**
 * Assessments workspace E2E (demo mode) — drives the complete governed loop:
 * invitation → simulated patient onboarding → immutable submission →
 * practitioner review (per-lab decisions) → protocol draft → approval BLOCKED
 * (all products pending verification) → Tasks + patient chart surfacing.
 *
 * Session state is sessionStorage-backed, so each flow keeps to one page
 * context; navigations (not new contexts) preserve the demo session.
 */

test("full loop: invite → submit (elevated) → review → decide → draft → approval blocked → surfaced", async ({
  page,
}) => {
  await page.goto("/assessments");
  await expect(page.getByRole("heading", { name: "Assessments" })).toBeVisible();
  await expect(page.getByText("No submissions to review")).toBeVisible();

  // --- invite
  await page.getByRole("tab", { name: "Invitations" }).click();
  const patientId = await page.locator("#invite-patient").inputValue();
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitation sent")).toBeVisible();

  // --- simulated patient side: progress (autosave), then submission
  await page.getByRole("button", { name: "Simulate patient progress" }).click();
  await expect(page.getByText("In progress (autosaved)")).toBeVisible();
  await page.getByRole("button", { name: "Simulate submission…" }).click();
  await page.getByRole("button", { name: /Elevated mold \+ gut pattern/ }).click();
  await expect(page.getByText("Submitted", { exact: true })).toBeVisible();

  // --- review: bands, provenance, deterministic lab candidates
  await page.getByRole("tab", { name: "Review" }).click();
  await expect(page.getByText("Pending practitioner review").first()).toBeVisible();
  await expect(page.getByText("Elevated", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/scoring scoring\.v2/).first()).toBeVisible();
  await expect(page.getByText(/content [0-9a-f]{12}…/).first()).toBeVisible();
  await expect(page.getByText("Mycotoxin Panel").first()).toBeVisible();
  await expect(page.getByText("Gut Zoomer").first()).toBeVisible();
  await expect(page.getByText("order link unreviewed").first()).toBeVisible();

  // --- per-lab decisions: approve one, order-draft another (append-only history)
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  await expect(page.getByText(/—\s*approve/).first()).toBeVisible();
  await page.getByRole("button", { name: "Create order draft" }).first().click();

  // --- protocol draft from template; approval must be BLOCKED
  await page.getByRole("button", { name: "Draft protocol…" }).click();
  await page.locator("#pd-template").selectOption("tpl_foundation_v1");
  await expect(page.getByText("Registry products (2 selected)")).toBeVisible();
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.getByRole("tab", { name: "Protocol drafts" }).click();
  await expect(page.getByText(/Foundational support/).first()).toBeVisible();
  await expect(page.getByText("pending verification").first()).toBeVisible();
  await page.getByRole("button", { name: "Attempt approval" }).click();
  await expect(page.getByText(/Approval blocked/)).toBeVisible();
  await expect(page.getByText(/No unapproved product can enter an approved protocol/)).toBeVisible();

  // --- surfaced to Tasks (queue items) and the patient chart
  await page.goto("/tasks");
  await expect(page.getByText(/Review symptom-pattern screening/).first()).toBeVisible();
  await expect(page.getByText(/Lab order draft — /).first()).toBeVisible();

  await page.goto(`/patients/${patientId}/summary`);
  await expect(page.getByTestId("patient-screening-card")).toBeVisible();
  await expect(
    page.getByTestId("patient-screening-card").getByText("Elevated", { exact: true }).first(),
  ).toBeVisible();
});

test("insufficient answers report 'needs more answers' — never a fabricated score", async ({
  page,
}) => {
  await page.goto("/assessments");
  await page.getByRole("tab", { name: "Invitations" }).click();
  await page.getByRole("button", { name: "Send invitation" }).click();
  await page.getByRole("button", { name: "Simulate submission…" }).click();
  await page.getByRole("button", { name: /Sparse answers — insufficient data/ }).click();

  await page.getByRole("tab", { name: "Review" }).click();
  await expect(page.getByText("Needs more answers").first()).toBeVisible();
  // Below the completeness floor no category reaches moderate — the rules
  // produce zero lab candidates rather than acting on unreliable scores.
  await expect(
    page.getByText("No categories reached the moderate threshold — no lab candidates from the rules."),
  ).toBeVisible();
  // Null scores render as "—", not 0.
  await expect(page.getByText("—", { exact: true }).first()).toBeVisible();
});

test("registry library shows governance state (all products pending, links unreviewed)", async ({
  page,
}) => {
  await page.goto("/assessments");
  await page.getByRole("tab", { name: "Registry library" }).click();
  await expect(page.getByText(/Authoritative list/).first()).toBeVisible();
  await expect(page.getByText("not found").first()).toBeVisible();
  await expect(page.getByText("pending", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("vendor unverified").first()).toBeVisible();
  await expect(page.getByText(/15 products are\s+pending verification/).first()).toBeVisible();
});
