import { expect, test } from "@playwright/test";

/** The actual Next server and browser, not intercepted clinical responses.
 * No credentials, patient records, fixture backend or provider calls are used.
 * This qualifies the framework's public/denied boundary only, not clinical flows.
 */
// Development deliberately uses a different CSP for source-map evaluation.
// The dedicated production CI step below runs every case without this selector.
test.skip(process.env.E2E_DEV_SERVER === "1", "production-server boundary runs in the dedicated built-runtime CI step");

test("built sign-in hydrates without external traffic or client exceptions", async ({ page, baseURL }, testInfo) => {
  const exceptions: string[] = [];
  const external: string[] = [];
  const allowedOrigin = new URL(baseURL!).origin;
  page.on("pageerror", error => exceptions.push(error.message));
  page.on("request", request => {
    if (new URL(request.url()).origin !== allowedOrigin) external.push(request.url());
  });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Practitioner sign-in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeEditable();
  await expect(page.getByLabel("Password")).toBeEditable();
  await page.getByLabel("Email").fill("fictional-framework@example.invalid");
  await page.getByLabel("Password").fill("not-submitted-fictional-value");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("framework-sign-in.png") });
  expect(exceptions).toEqual([]);
  expect(external).toEqual([]);
});

for (const route of ["program-assignments", "protocol-carts"]) {
  test(`${route} refuses a missing identity with an uncached response`, async ({ page }) => {
    await page.goto("/login");
    const result = await page.evaluate(async path => {
      const response = await fetch(path, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
    }, `/api/live/${route}`);
    expect(result).toEqual({ status: 401, cache: "no-store", body: { error: "reauth_required" } });
  });

  test(`${route} refuses foreign origins before identity or provider access`, async ({ request }) => {
    const response = await request.post(`/api/live/${route}`, {
      headers: { origin: "https://foreign.example.invalid" }, data: {},
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toEqual({ error: "identity_refused" });
  });
}

test("recording surfaces retain the no-tracker and no-framing policy", async ({ request }) => {
  for (const route of ["/settings/privacy-operations", "/patients/fictional/encounter/fictional"]) {
    const response = await request.get(route, { maxRedirects: 0 });
    const policy = response.headers()["content-security-policy"];
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
});

test("signed-out chart navigation reaches sign-in instead of a server error", async ({ page }) => {
  const exceptions: string[] = [];
  page.on("pageerror", error => exceptions.push(error.message));
  const response = await page.goto("/patients/fictional/encounter/fictional");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(new URL(page.url()).searchParams.get("next")).toBe("/patients/fictional/encounter/fictional");
  await expect(page.getByRole("heading", { name: "Practitioner sign-in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeEditable();
  expect(exceptions).toEqual([]);
});

test("an expired chart session without refresh returns to sign-in and drops its cookies", async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: "aidp_at", value: "fictional-expired-not-a-token", url: baseURL! },
    { name: "aidp_exp", value: "1", url: baseURL! },
  ]);
  const response = await page.goto("/patients/fictional/encounter/fictional");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByLabel("Email")).toBeEditable();
  expect((await context.cookies()).filter(cookie => cookie.name.startsWith("aidp_"))).toEqual([]);
});
