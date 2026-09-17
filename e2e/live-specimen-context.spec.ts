import { expect, test, type Page } from "@playwright/test";
import { buildLabWorkspace, type LabObservationRow } from "../src/adapters/labs.map";
import { labSpecimenRecordSchema } from "../src/contracts/labSpecimenTransfer";
import { resetBackend } from "./support/backend";

/** Browser interaction proof only: the clinical shell uses the local fixture;
 * lab workspace and context responses below are explicitly synthetic. AWS,
 * consent activation and PostgreSQL authorization are NOT proved by this suite.
 * The real context route deliberately refuses the local-contract transport. */
test.skip(!process.env.E2E_LIVE, "Requires the local clinical contract-fixture server");
test.beforeAll(resetBackend);

const PATIENT = "aaaaaaaa-1111-2222-3333-444444444401";
const EVENT = "60000000-0000-4000-8000-000000000001";
const OTHER_EVENT = "60000000-0000-4000-8000-000000000002";
const OBSERVATION = "30000000-0000-4000-8000-000000000001";
const CONTEXT_ROUTE = "**/api/live/labs/specimen-context";
function observation(second = false): LabObservationRow {
  return {
    id: second ? "30000000-0000-4000-8000-000000000002" : OBSERVATION,
    import_event_id: second ? OTHER_EVENT : EVENT,
    biomarker_definition_id: null, canonical_name: second ? "Ferritin" : "TSH",
    biological_system: "Synthetic test", value_numeric: second ? 75 : 2.1,
    value_text: null, unit: second ? "ng/mL" : "mIU/L", status: "normal",
    original_reference_interval: second ? "30–150" : "0.45–4.50",
    confidence: null, provenance: "Synthetic browser fixture", review_status: "unreviewed",
    reviewed_at: null, observed_at: "2026-07-20T12:00:00Z", ingested_at: "2026-07-21T12:00:00Z",
    lab_document_id: null, source: "patient_app", document_file_name: null, document_lab_company: null,
  };
}
const record = labSpecimenRecordSchema.parse({
  version: "lab-specimen-record/1", contextId: "70000000-0000-4000-8000-000000000001",
  labEventId: EVENT, revision: 1, payloadSha256: "a".repeat(64), labPayloadSha256: "b".repeat(64),
  receivedAt: "2026-07-22T12:00:00Z",
  context: { source: "patient_reported", verification: "unverified", recordedAt: "2026-07-21T12:00:00Z",
    observedOn: "2026-07-20", ageAtDraw: { value: 42, unit: "years" }, sex: null,
    assayId: "SYNTHETIC-ASSAY-ONLY", pregnancyStatus: null, pregnancyTrimester: null,
    cyclePhase: null, reproductiveStage: null, contraception: null },
});
const card = (page: Page) => page.getByRole("region", { name: "Patient-shared collection context" });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/live/labs/workspace", async route => {
    expect(route.request().postDataJSON()).toEqual({ patientId: PATIENT });
    await route.fulfill({ json: { data: buildLabWorkspace({ patientId: PATIENT,
      patientName: "Fixture Patient", observations: [observation(), observation(true)], documents: [] }) } });
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/today");
  await page.goto(`/patients/${PATIENT}/labs`);
  await page.getByRole("button", { name: "Select TSH", exact: true }).click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator("[data-nextjs-dialog], .vite-error-overlay")).toHaveCount(0);
});

test("explicit load sends the exact selection and renders unverified facts without defaults", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests: unknown[] = [];
  await page.route(CONTEXT_ROUTE, async route => {
    requests.push(route.request().postDataJSON());
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ json: { data: record } });
  });
  expect(requests).toEqual([]);
  await card(page).getByRole("button", { name: "Load shared collection context" }).click();
  await expect(card(page).getByText("42 years", { exact: true })).toBeVisible();
  await expect(card(page).getByText("Not shared", { exact: true })).toHaveCount(6);
  await expect(card(page).getByText(/SYNTHETIC-ASSAY-ONLY.*not verified/)).toBeVisible();
  await expect(card(page).getByText(/patient-reported and unverified/)).toBeVisible();
  expect(requests).toEqual([{ patientId: PATIENT, observationId: OBSERVATION, eventId: EVENT }]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("synthetic-context.png"), fullPage: true });
});

test("an access refusal is not an empty record and refresh removes previously displayed context", async ({ page }) => {
  let status = 200;
  await page.route(CONTEXT_ROUTE, route => route.fulfill({ status, json: status === 200 ? { data: record } : { error: "private backend detail" } }));
  await card(page).getByRole("button").click();
  await expect(card(page).getByText("42 years", { exact: true })).toBeVisible();
  status = 403;
  await card(page).getByRole("button").click();
  await expect(card(page).getByRole("alert")).toHaveText("Shared context is not enabled or you do not have access.");
  await expect(card(page).getByText("42 years", { exact: true })).toHaveCount(0);
  await expect(card(page).getByText(/No shared collection context/)).toHaveCount(0);
  await expect(page.getByText("private backend detail")).toHaveCount(0);
});

test("empty result and invalid or mismatched context stay distinct", async ({ page }) => {
  let data: unknown = null;
  await page.route(CONTEXT_ROUTE, route => route.fulfill({ json: { data } }));
  await card(page).getByRole("button").click();
  await expect(card(page).getByText("No shared collection context is available for this exact result.")).toBeVisible();
  for (const invalid of [{ ...record, labEventId: OTHER_EVENT }, { ...record, context: { ...record.context, verification: "verified" } }]) {
    data = invalid;
    await card(page).getByRole("button").click();
    await expect(card(page).getByRole("alert")).toHaveText("The service did not return matching collection context.");
    await expect(card(page).getByText("42 years", { exact: true })).toHaveCount(0);
  }
});

test("changing the selected result cancels old context and requires another explicit load", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  await page.route(CONTEXT_ROUTE, async route => {
    started(); await held;
    await route.fulfill({ json: { data: record } }).catch(() => undefined);
  });
  await card(page).getByRole("button").click();
  await dispatched;
  await expect(card(page).getByRole("button")).toBeDisabled();
  await page.getByRole("button", { name: "Select Ferritin", exact: true }).click();
  release();
  await expect(card(page).getByRole("button", { name: "Load shared collection context" })).toBeEnabled();
  await expect(card(page).getByText("42 years", { exact: true })).toHaveCount(0);
});
