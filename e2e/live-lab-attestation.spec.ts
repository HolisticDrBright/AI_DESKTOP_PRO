import { expect, test, type Page, type Request } from "@playwright/test";
import { buildLabWorkspace, type LabObservationRow } from "../src/adapters/labs.map";
import { resetBackend } from "./support/backend";
import {
  FICTIONAL_REPORT_BYTES, LAB_ATTESTATION_DRAWN, LAB_ATTESTATION_EVENT, LAB_ATTESTATION_LEGACY_EVENT, LAB_ATTESTATION_LEGACY_OBSERVATION,
  LAB_ATTESTATION_OBSERVATION, LAB_ATTESTATION_PATIENT, OTHER_FICTIONAL_REPORT_BYTES, FICTIONAL_REPORT_SHA256,
} from "../scripts/lab-attestation-fixture.mjs";

/**
 * Reviewer value attestation, in the browser, through the real Desktop routes to the loopback fixture backend, with
 * fictional values only. The lab workspace list is served synthetic below (as the specimen-context suite does) so a
 * governed reading is on screen; the attestation view, the bound request, refusals and the readback go through
 * /api/live/lab-attestations to the fixture, which keeps the BLOCKED candidate's semantics and starts disabled.
 * AWS, activation and PostgreSQL authorization are NOT proved by this suite.
 */
test.skip(!process.env.E2E_LIVE, "Requires the local clinical contract-fixture server");
test.beforeAll(resetBackend);

const BACKEND = process.env.CLINICAL_SUPABASE_URL ?? "http://127.0.0.1:3999";
function row(id: string, event: string, name: string, value: number): LabObservationRow {
  return { id, import_event_id: event, biomarker_definition_id: null, canonical_name: name, biological_system: "Synthetic test",
    value_numeric: value, value_text: null, unit: "ng/mL", status: null, original_reference_interval: "30–400", confidence: null,
    provenance: "Synthetic browser fixture", review_status: "accepted", reviewed_at: null, observed_at: LAB_ATTESTATION_DRAWN,
    ingested_at: LAB_ATTESTATION_DRAWN, lab_document_id: null, source: "patient_app", document_file_name: null, document_lab_company: null };
}
const card = (page: Page) => page.getByRole("region", { name: "Value attestation" });
const control = (page: Page, body: unknown) => page.request.post(`${BACKEND}/__control/lab-attestation`, { data: body });
async function open(page: Page, marker = "Ferritin") {
  await page.getByRole("button", { name: `Select ${marker}`, exact: true }).click();
  await card(page).getByRole("button", { name: /value attestation/ }).click();
}
async function restate(page: Page, value = "420") {
  const form = card(page).getByRole("form", { name: "Restate and attest" });
  await form.getByLabel("Marker", { exact: true }).fill("Ferritin");
  await form.getByLabel("Value", { exact: true }).fill(value);
  await form.getByLabel("Unit", { exact: true }).fill("ng/mL");
  await form.getByLabel("Draw time (as shown above)", { exact: true }).fill(LAB_ATTESTATION_DRAWN);
  await form.getByLabel("The same marker, value, unit and draw time").check();
  await form.getByLabel(/I compared the four fields/).check();
  return form;
}
const chooseReport = (page: Page, bytes: Buffer = FICTIONAL_REPORT_BYTES, name = "fictional-report.pdf") =>
  card(page).getByLabel(/Select the report you compared/).setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });

test.beforeEach(async ({ page }) => {
  await resetBackend();
  await page.route("**/api/live/labs/workspace", route => route.fulfill({ json: { data: buildLabWorkspace({ patientId: LAB_ATTESTATION_PATIENT,
    patientName: "Fixture Patient", documents: [], observations: [
      row(LAB_ATTESTATION_OBSERVATION, LAB_ATTESTATION_EVENT, "Ferritin", 420),
      row(LAB_ATTESTATION_LEGACY_OBSERVATION, LAB_ATTESTATION_LEGACY_EVENT, "Iron legacy transfer", 900)] }) } }));
  await page.goto("/login");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/today");
  await page.goto(`/patients/${LAB_ATTESTATION_PATIENT}/labs`);
});

test("disabled by default: an explicit open says attestation is not enabled and the reading stays unverified", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", r => { if (r.url().includes("/api/live/lab-attestations")) requests.push(r.url()); });
  await page.getByRole("button", { name: "Select Ferritin", exact: true }).click();
  await expect(card(page)).toBeVisible();
  expect(requests).toEqual([]);
  await card(page).getByRole("button", { name: "Open value attestation" }).click();
  await expect(card(page).getByRole("status")).toHaveText("Value attestation is not enabled for this clinic. This reading stays unverified.");
  await expect(card(page).getByText(/Verified —|now shows this reading as verified/)).toHaveCount(0);
  await expect(card(page).getByRole("form")).toHaveCount(0);
});

test("the reading as stored beside the recorded report: a wrong file or a wrong field cannot be sent, and verified appears only after the readback", async ({ page }, testInfo) => {
  await control(page, { enabled: true });
  const order: string[] = [];
  const track = (r: Request) => { if (r.url().endsWith("/api/live/lab-attestations")) order.push("attest"); else if (r.url().endsWith("/api/live/lab-attestations/review")) order.push("review"); };
  page.on("request", track);
  await open(page);
  const reading = card(page).getByRole("group", { name: "Clinic reading as stored" });
  for (const [label, value] of [["Marker", "Ferritin"], ["Value", "420"], ["Unit", "ng/mL"], ["Draw time", LAB_ATTESTATION_DRAWN], ["Laboratory flag", "Not transferred"]])
    await expect(reading.getByText(label, { exact: true }).locator("xpath=following-sibling::dd[1]")).toHaveText(value);
  await expect(card(page).getByTestId("attestation-state")).toHaveText("Not verified — needs human review.");
  await expect(card(page).getByRole("group", { name: "Transferred report" }).getByText(FICTIONAL_REPORT_SHA256)).toBeVisible();

  const form = await restate(page, "421");
  await expect(form.getByText("Does not match the clinic record.")).toBeVisible();
  await chooseReport(page, OTHER_FICTIONAL_REPORT_BYTES, "another-report.pdf");
  await expect(card(page).getByText("This file is not any report the transfer recorded. It cannot be attested against.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Record attestation" })).toBeDisabled();
  await chooseReport(page);
  await expect(card(page).getByText("This is a report the transfer recorded.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Record attestation" })).toBeDisabled();
  await form.getByLabel("Value", { exact: true }).fill("420");
  await expect(form.getByText("Does not match the clinic record.")).toHaveCount(0);

  // Hold the readback: until it returns, the screen may say recorded, never verified.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let readbacks = 0;
  await page.route("**/api/live/lab-attestations/review", async route => { if (++readbacks === 1) await held; await route.continue(); });
  await form.getByRole("button", { name: "Record attestation" }).click();
  await expect(card(page).getByText("Attestation recorded. Reading it back from the clinic record…")).toBeVisible();
  await expect(card(page).getByTestId("attestation-state")).toHaveText("Not verified — needs human review.");
  await expect(card(page).getByText(/now shows this reading as verified/)).toHaveCount(0);
  release();
  await expect(card(page).getByText("Read back: the clinic record now shows this reading as verified (measured value only).")).toBeVisible();
  await expect(card(page).getByTestId("attestation-state")).toHaveText("Verified — measured value only, from the clinic record. The reference range is not verified.");
  expect(order).toEqual(["review", "attest", "review"]);
  await page.screenshot({ path: testInfo.outputPath("attestation-verified.png"), fullPage: true });

  // A fresh open reads the same state from the record.
  await page.unroute("**/api/live/lab-attestations/review");
  await card(page).getByRole("button", { name: "Reload value attestation" }).click();
  await expect(card(page).getByTestId("attestation-state")).toHaveText(/^Verified — measured value only/);
});

test("another reviewer attested after this view loaded: the submission is refused as stale and nothing is claimed for it", async ({ page }) => {
  await control(page, { enabled: true });
  await open(page);
  const form = await restate(page);
  await chooseReport(page);
  await control(page, { attestAsColleague: { observationId: LAB_ATTESTATION_OBSERVATION, outcome: "refuted" } });
  await form.getByRole("button", { name: "Record attestation" }).click();
  await expect(card(page).getByRole("alert").filter({ hasText: "changed after you opened it" })).toBeVisible();
  await expect(card(page).getByText(/Read back/)).toHaveCount(0);
  await card(page).getByRole("button", { name: "Reload value attestation" }).click();
  await expect(card(page).getByTestId("attestation-state")).toHaveText("Refuted — a reviewer recorded that the report does not show this reading.");
});

test("a lost reply is retried as the same request and answered from its own record, never recorded twice", async ({ page }) => {
  await control(page, { enabled: true });
  await open(page);
  const form = await restate(page);
  await chooseReport(page);
  const bodies: { attestation: { requestId: string } }[] = [];
  let lose = true;
  await page.route("**/api/live/lab-attestations", async route => {
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (lose) { lose = false; await route.fulfill({ status: 503, json: { error: { code: "service_unavailable" } } }); return; }
    await route.fulfill({ response });
  });
  await form.getByRole("button", { name: "Record attestation" }).click();
  await expect(card(page).getByRole("alert").filter({ hasText: "could not be recorded. Nothing has been verified." })).toBeVisible();
  await expect(card(page).getByTestId("attestation-state")).toHaveText("Not verified — needs human review.");
  await form.getByRole("button", { name: "Try again" }).click();
  await expect(card(page).getByText("Read back: the clinic record now shows this reading as verified (measured value only).")).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.attestation.requestId).toBe(bodies[0]!.attestation.requestId);
  const view = await page.evaluate(async ([patientId, observationId]) => (await (await fetch("/api/live/lab-attestations/review", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId, observationId }) })).json()).data,
  [LAB_ATTESTATION_PATIENT, LAB_ATTESTATION_OBSERVATION]);
  expect(view.verification.history).toHaveLength(1);
});

test("a legacy lab-result/1 reading shows its stored status only as the app's assessment and offers no attestation", async ({ page }) => {
  await control(page, { enabled: true });
  await open(page, "Iron legacy transfer");
  const reading = card(page).getByRole("group", { name: "Clinic reading as stored" });
  await expect(reading.getByText("critical (the app’s, unreviewed — not a laboratory flag)")).toBeVisible();
  await expect(reading.getByText("Laboratory flag", { exact: true }).locator("xpath=following-sibling::dd[1]")).toHaveText("Not transferred");
  await expect(card(page).getByText(/names no report it was read from/)).toBeVisible();
  await expect(card(page).getByRole("form")).toHaveCount(0);
  await expect(card(page).getByLabel(/Select the report you compared/)).toHaveCount(0);
});

test("changing the selected reading drops an answer for the previous one: nothing crosses readings or patients", async ({ page }) => {
  await control(page, { enabled: true });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/live/lab-attestations/review", async route => { started(); await held; await route.continue().catch(() => undefined); });
  await open(page);
  await dispatched;
  await page.getByRole("button", { name: "Select Iron legacy transfer", exact: true }).click();
  release();
  await expect(card(page).getByRole("button", { name: "Open value attestation" })).toBeEnabled();
  await expect(card(page).getByText(FICTIONAL_REPORT_SHA256)).toHaveCount(0);
  await expect(card(page).getByRole("group", { name: "Clinic reading as stored" })).toHaveCount(0);
});
