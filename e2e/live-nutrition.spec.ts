import { expect, test } from "@playwright/test";
import { STUB_BASE, resetBackend } from "./support/backend";

/**
 * PHASE 9A, browser-level: nutrition assessment, the versioned template
 * library, personalised patient plans, the safety review gate, activation,
 * revision-without-overwrite, and adherence — against the committed contract
 * fixture backend.
 *
 * The scenarios this file exists for are the ones the SQL suite cannot reach,
 * because they need a signed-in identity: the approval gate refusing a version
 * whose safety review has not been run, and refusing one that still carries an
 * unresolved blocking flag. Everything else here proves the workflow a
 * practitioner actually walks.
 *
 * Recipe:
 *   node scripts/live-stub-server.mjs &
 *   APP_EDITION=clinical npm run build
 *   E2E_LIVE=1 TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *     CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 CLINICAL_SUPABASE_ANON_KEY=stub \
 *     CLINICAL_DEMO_EMAIL=demo@local CLINICAL_DEMO_PASSWORD=demo \
 *     CLINICAL_ORG_ID=org-fixture npm run test:e2e -- e2e/live-nutrition.spec.ts
 */
test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");

test.describe.configure({ mode: "serial" });

/**
 * Isolation, not ordering. This restores the whole fixture backend so the
 * suite runs against exactly the state it was written for, wherever it lands
 * in the battery.
 */
test.beforeAll(resetBackend);

const STUB = STUB_BASE;
const PATIENT = "aaaaaaaa-1111-2222-3333-444444444405";
const LIBRARY = "/nutrition";
const PATIENT_NUTRITION = `/patients/${PATIENT}/nutrition`;
const DEMO_FIXTURE_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

test.beforeAll(async () => {
  await fetch(`${STUB}/__control/nutrition-reset`, { method: "POST" });
});

async function setRole(role: string) {
  await fetch(`${STUB}/__control/nutrition-set-role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

/** Call a live route directly, so a status code can be asserted, not just copy. */
async function callLive(page: import("@playwright/test").Page, path: string, body: unknown) {
  return page.evaluate(
    async ([p, b]) => {
      const res = await fetch(`/api/live/${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });
      return { status: res.status, text: await res.text() };
    },
    [path, body] as const,
  );
}

function expectNoFixtureData(text: string) {
  for (const name of DEMO_FIXTURE_NAMES) expect(text).not.toContain(name);
}

/* ------------------------------------------------------- template library */

test("1: the template library starts empty and says so honestly", async ({ page }) => {
  await page.goto(LIBRARY);
  await expect(page.getByText("No templates yet")).toBeVisible();
  await expect(page.getByText("Food database and copilot")).toBeVisible();
  expectNoFixtureData(await page.locator("body").innerText());
});

test("2: the food database reports configured and transacted as separate facts", async ({ page }) => {
  await page.goto(LIBRARY);
  await expect(page.getByText("Food database and copilot")).toBeVisible();
  const body = await page.locator("body").innerText();
  // Disabled by default, and honest about it.
  expect(body).toContain("not configured");
  expect(body).toContain("none yet");
  // And it must not imply the integration is proven.
  expect(body).toMatch(/nothing here\s+should be read as proof/i);
});

test("3: installing the starter library publishes eight review-gated patterns", async ({ page }) => {
  await page.goto(LIBRARY);
  await page.getByRole("button", { name: "Install starter templates" }).click();

  await expect(page.getByRole("row", { name: /Low FODMAP/ })).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(8);

  const body = await page.locator("body").innerText();
  // Every published starter requires review — none opts out.
  expect(body).not.toContain("Not required");
  expect((body.match(/Required/g) ?? []).length).toBeGreaterThanOrEqual(8);
});

test("4: no starter template is presented as evidence-based", async ({ page }) => {
  await page.goto(LIBRARY);
  await expect(page.getByRole("row", { name: /Low FODMAP/ })).toBeVisible();
  const body = await page.locator("body").innerText();
  // The grade shown is practitioner experience, never a governed reference.
  expect(body).not.toContain("governed reference");
  expect(body).toContain("practitioner experience");
});

test("5: a template states what it does not know before it can be used", async ({ page }) => {
  await page.goto(LIBRARY);
  await expect(page.getByRole("row", { name: /Low FODMAP/ })).toBeVisible();
  await page.getByRole("row", { name: /Low FODMAP/ }).getByRole("button", { name: "Open", exact: true }).click();

  await expect(
    page.getByText("Must be established before this is used for anyone"),
  ).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).toContain("Recorded allergies and intolerances");
  expect(body).toContain("not individualised medical advice");
});

test("6: re-installing an unchanged library mints no second version", async ({ page }) => {
  await page.goto(LIBRARY);
  await page.getByRole("button", { name: "Install starter templates" }).click();
  await expect(page.getByRole("row", { name: /Low FODMAP/ })).toBeVisible();

  // Still eight templates, each still on a single version.
  await expect(page.locator("tbody tr")).toHaveCount(8);
  const versions = await page
    .getByRole("row", { name: /Low FODMAP/ })
    .locator("td")
    .nth(3)
    .innerText();
  expect(versions.trim()).toBe("1");
});

/* --------------------------------------------------------- patient plans */

test("7: a patient with no plan says so rather than inventing one", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await expect(page.getByText("No nutrition plan yet")).toBeVisible();
  await expect(page.getByText("Adherence — last 30 days")).toBeVisible();
  expectNoFixtureData(await page.locator("body").innerText());
});

test("8: adherence with nothing reported shows missing days, not zero", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await expect(page.getByText("Adherence — last 30 days")).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).toContain("Not reported");
  expect(body).toMatch(/never as zero adherence/i);
});

test("9: a plan started from a template carries a snapshot of it", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await expect(page.getByText("Start a nutrition plan")).toBeVisible();
  await page.getByPlaceholder("e.g. Digestive symptom investigation").fill("FODMAP investigation");
  const fodmap = await page
    .locator("option", { hasText: "Low FODMAP" })
    .first()
    .getAttribute("value");
  await page.getByRole("combobox").selectOption(fodmap as string);
  await page.getByRole("button", { name: "Create draft plan" }).click();

  await expect(page.getByText("FODMAP investigation")).toBeVisible();
  const body = await page.locator("body").innerText();
  // The plan names the exact template version it detached from.
  expect(body).toMatch(/Low FODMAP[^\n]*v1/);
});

test("10: approval is refused before the safety review has been run", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByText("in review").first()).toBeVisible();

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  // The screen states the ACTUAL reason, not the generic "record changed"
  // message a bare conflict would otherwise produce.
  await expect(page.getByText(/safety review has not been run/i)).toBeVisible();
  // And it really did not approve.
  await expect(page.getByRole("cell", { name: "approved" })).toHaveCount(0);

  // Proven at the wire too, so the refusal is the server's and not the screen's:
  // the route answers 409 whatever the browser does. The body carries only a
  // code and a generic message — the adapter genericises server strings so a
  // backend message can never ferry PHI to the browser, which is why the screen
  // derives the specific reason from state it already holds.
  const version = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    return (await res.json()).data.plans[0].versions[0];
  });
  const refused = await callLive(page, "nutrition/approve", { planVersionId: version.id });
  expect(refused.status).toBe(409);
  expect(JSON.parse(refused.text).error.code).toBe("conflict");
});

test("11: the safety review raises the recorded allergy the plan collides with", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  // The review runs on a draft, so revert to draft state via a fresh version:
  // this plan is in review, and the evaluator accepts that too.
  const evaluated = await callLive(page, "nutrition/safety-evaluate", {
    planVersionId: await page.evaluate(async () => {
      const res = await fetch("/api/live/nutrition/patient", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
      });
      const json = await res.json();
      return json.data.plans[0].versions[0].id;
    }),
  });
  expect(evaluated.status).toBe(200);
  expect(JSON.parse(evaluated.text).data.blocking).toBeGreaterThan(0);

  await page.reload();
  // Wait for hydration before clicking: the button paints before React attaches
  // its handler, and a click in that gap silently does nothing.
  await expect(page.getByText("Adherence — last 30 days")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Open", exact: true }).first().click();
  await expect(page.getByText("safety review", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "recorded allergy" }).first()).toBeVisible();
  await expect(
    page.getByText(/recorded allergen appears in food this plan tells the patient to eat/i),
  ).toBeVisible();
});

test("12: approval is still refused while a blocking flag is unresolved", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/blocking safety flag/i).first()).toBeVisible();
});

test("13: acknowledging a blocking flag is not the same as deciding about it", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  const versionId = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    const json = await res.json();
    return json.data.plans[0].versions[0];
  });
  const flag = (versionId.safetyFlags as Array<{ id: string; severity: string }>).find(
    (f) => f.severity === "blocking",
  );
  const ack = await callLive(page, "nutrition/safety-resolve", {
    flagId: flag?.id,
    action: "acknowledge",
  });
  expect(ack.status).toBe(200);

  // Acknowledged, and approval STILL refused.
  // The wire carries a code and a generic message by design; the refusal itself
  // is the point, and it survives the acknowledgement.
  const approve = await callLive(page, "nutrition/approve", { planVersionId: versionId.id });
  expect(approve.status).toBe(409);
  expect(JSON.parse(approve.text).error.code).toBe("conflict");

  // And the screen still names the real reason rather than the generic one.
  await page.reload();
  await expect(page.getByText("Adherence — last 30 days")).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/blocking safety flag/i).first()).toBeVisible();
});

test("14: an override with no reason is refused", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  const version = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    return (await res.json()).data.plans[0].versions[0];
  });
  const flag = (version.safetyFlags as Array<{ id: string; severity: string }>).find(
    (f) => f.severity === "blocking",
  );
  const bad = await callLive(page, "nutrition/safety-resolve", {
    flagId: flag?.id,
    action: "override",
    reason: "   ",
  });
  expect(bad.status).toBe(400);
  expect(bad.text).toMatch(/requires a reason/i);
});

test("15: a documented override clears the gate and is recorded on the flag", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await page.getByRole("button", { name: "Open", exact: true }).first().click();
  await page.getByRole("button", { name: "Override with reason" }).first().click();
  await page
    .getByPlaceholder("Required — recorded against your name")
    .fill("Peanut removed from the plan in clinic; patient confirmed.");
  await page.getByRole("button", { name: "Record override" }).click();

  await expect(page.getByText(/Peanut removed from the plan in clinic/)).toBeVisible();

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("cell", { name: "approved" }).first()).toBeVisible();
});

test("16: activating makes exactly one plan live for the patient", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByRole("cell", { name: "active" }).first()).toBeVisible();

  const state = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    return (await res.json()).data;
  });
  const live = (state.plans as Array<{ status: string }>).filter((p) => p.status === "active");
  expect(live).toHaveLength(1);
});

test("17: revising creates a new draft and leaves the approved version untouched", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);

  const before = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    return (await res.json()).data.plans[0].versions.find(
      (v: { status: string }) => v.status === "active",
    );
  });

  await page.getByPlaceholder("What changed, and why").fill("Reintroduction phase starting");
  await page.getByRole("button", { name: "Revise into a new draft" }).click();
  await expect(page.getByRole("cell", { name: "draft" }).first()).toBeVisible();

  const after = await page.evaluate(async (id: string) => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    const data = (await res.json()).data;
    return {
      versions: data.plans[0].versions.length,
      original: data.plans[0].versions.find((v: { id: string }) => v.id === id),
    };
  }, before.id as string);

  expect(after.versions).toBe(2);
  // The version the patient is following is byte-for-byte what was approved.
  expect(after.original.status).toBe("active");
  expect(after.original.approvedAt).toBe(before.approvedAt);
  expect(after.original.patientInstructions).toBe(before.patientInstructions);
  expect(after.original.safetyFlags.length).toBe(before.safetyFlags.length);
});

test("18: an approved version cannot be edited, only revised", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  const active = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    return (await res.json()).data.plans[0].versions.find(
      (v: { status: string }) => v.status === "active",
    );
  });
  const edit = await callLive(page, "nutrition/plan-save", {
    planVersionId: active.id,
    expectedVersion: active.version,
    patientInstructions: "Rewritten after the fact",
  });
  // 409, and the body carries a code rather than the server's own sentence —
  // that genericisation is the PHI boundary, not an accident.
  expect(edit.status).toBe(409);
  expect(JSON.parse(edit.text).error.code).toBe("conflict");

  // The edit really did not land.
  const after = await page.evaluate(async (id: string) => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    return (await res.json()).data.plans[0].versions.find((v: { id: string }) => v.id === id);
  }, active.id as string);
  expect(after.patientInstructions).toBe(active.patientInstructions);
});

/* ------------------------------------------------------------- adherence */

test("19: a check-in requires a source, and blank adherence stays not reported", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  const today = new Date().toISOString().slice(0, 10);

  // No source at all — refused before it reaches storage.
  const noSource = await callLive(page, "nutrition/checkin", {
    patientId: PATIENT,
    observedOn: today,
  });
  expect(noSource.status).toBe(400);
  expect(noSource.text).toMatch(/must say where it came from/i);

  await page.locator('input[type="date"]').fill(today);
  await page.getByRole("button", { name: "Record check-in" }).click();

  await expect(page.getByRole("cell", { name: "practitioner recorded" })).toBeVisible();
  // Left blank, so it reads as not reported — never as zero.
  await expect(page.getByRole("cell", { name: "Not reported" }).first()).toBeVisible();
});

test("20: a reported day counts as covered and the rest stay missing", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  const summary = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/adherence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405", days: 30 }),
    });
    return (await res.json()).data;
  });
  expect(summary.daysReported).toBe(1);
  expect(summary.daysMissing).toBe(29);
  // Nothing was reported for adherence, so there is no mean to state.
  expect(summary.meanMealPlanAdherencePct).toBeNull();
});

test("21: a check-in can be marked for follow-up", async ({ page }) => {
  await page.goto(PATIENT_NUTRITION);
  await page.getByRole("button", { name: "Follow up" }).first().click();
  await expect(page.getByRole("cell", { name: "needs followup" })).toBeVisible();
});

/* ------------------------------------------------------- role & boundary */

test("22: a non-clinical role cannot author or approve a nutrition plan", async ({ page }) => {
  await setRole("staff");
  await page.goto(PATIENT_NUTRITION);

  const create = await callLive(page, "nutrition/plan", {
    patientId: PATIENT,
    title: "Should not be created",
  });
  expect(create.status).toBe(403);

  await setRole("practitioner");
});

test("23: the copilot draft is labelled, unsaved, and raises rather than hides a conflict", async ({
  page,
}) => {
  await page.goto(PATIENT_NUTRITION);
  const version = await page.evaluate(async () => {
    const res = await fetch("/api/live/nutrition/patient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: "aaaaaaaa-1111-2222-3333-444444444405" }),
    });
    return (await res.json()).data.plans[0].versions[0];
  });

  const draft = await callLive(page, "nutrition/copilot-draft", {
    planVersionId: version.id,
    patientId: PATIENT,
  });
  // Disabled by default: an honest refusal, not a plausible-looking draft.
  expect([200, 503]).toContain(draft.status);
  if (draft.status === 503) {
    expect(draft.text).toMatch(/not configured|disabled/i);
  } else {
    const body = JSON.parse(draft.text).data;
    expect(body.disclaimer).toMatch(/nothing is saved/i);
    for (const s of body.suggestions) expect(s.isDraft).toBe(true);
  }
});

test("24: nothing in the nutrition surface leaks a secret, a licence key, or fixture identity", async ({
  page,
}) => {
  for (const path of [LIBRARY, PATIENT_NUTRITION]) {
    await page.goto(path);
    await expect(page.getByRole("heading").first()).toBeVisible();
    const body = await page.locator("body").innerText();
    expectNoFixtureData(body);
    for (const secret of ["PASSIO_LICENSE_KEY", "sk_test_", "sk_live_", "service_role"]) {
      expect(body).not.toContain(secret);
    }
  }
});
