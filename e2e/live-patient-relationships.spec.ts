import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");
test.describe.configure({ mode: "serial" });
test.beforeAll(resetBackend);
test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/today");
});

const PATIENT = "aaaaaaaa-1111-2222-3333-444444444401";

test("creates a scope-limited family approval request and persists its pending state", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/overview`);
  const card = page.getByTestId("patient-relationships-card");
  await expect(card.getByText("Family access", { exact: true })).toBeVisible();
  await expect(card.getByText("No family access relationships recorded.")).toBeVisible();

  await card.getByRole("button", { name: "Add relationship" }).click();
  await page.getByLabel("Family member name *").fill("Synthetic Adult Child");
  await page.getByLabel("Email *").fill("caregiver@example.invalid");
  await page.getByLabel("Relationship *").selectOption("adult_child");
  await page.getByLabel("Laboratory results").check();
  const attestation = page.getByLabel("I confirm this uses fictional test identity information only.");
  if (await attestation.count()) await attestation.check();
  await page.getByRole("button", { name: "Create approval request" }).click();

  await expect(page.getByText("Waiting for patient approval")).toBeVisible();
  await expect(page.locator("code")).toHaveText(/^[A-HJ-NP-Z2-9]{10}$/);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(card.getByText("Synthetic Adult Child · Adult child")).toBeVisible();
  await expect(card.getByText("pending patient approval")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("patient-relationships-card").getByText("Synthetic Adult Child · Adult child")).toBeVisible();
});

test("revocation requires a reason and remains visible after reload", async ({ page }) => {
  await page.goto(`/patients/${PATIENT}/overview`);
  await page.getByTestId("patient-relationships-card").getByRole("button", { name: "Revoke access" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke family access" });
  await dialog.getByLabel("Reason for audit record *").fill("Patient withdrew access");
  await dialog.getByRole("button", { name: "Revoke access" }).click();

  await expect(page.getByTestId("patient-relationships-card").getByText("revoked")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("patient-relationships-card").getByText("revoked")).toBeVisible();
});
