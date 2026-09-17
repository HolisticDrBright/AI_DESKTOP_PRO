import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

test.skip(!process.env.E2E_LIVE, "Requires the local clinical contract-fixture server");
test.beforeAll(resetBackend);

test("successful sign-in performs a document navigation to the requested local screen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/login?next=%2Fpatients");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  const document = page.waitForRequest(request => request.isNavigationRequest()
    && request.resourceType() === "document" && new URL(request.url()).pathname === "/patients");
  await page.getByRole("button", { name: "Sign in" }).click();
  await document;
  await expect(page).toHaveURL(/\/patients$/);
  await expect(page.getByRole("button", { name: "Add patient", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("backslash return target cannot navigate to another origin", async ({ page, baseURL }) => {
  const outside: string[] = [];
  const origin = new URL(baseURL!).origin;
  await page.route("**/*", async route => {
    if (new URL(route.request().url()).origin !== origin) {
      outside.push(route.request().url()); await route.abort(); return;
    }
    await route.continue();
  });
  await page.goto(`/login?next=${encodeURIComponent("/\\elsewhere.invalid")}`);
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/today$/);
  expect(outside).toEqual([]);
});

test("a failed logout does not claim success; retry clears the session", async ({ page }) => {
  await page.goto("/login?next=%2Fpatients");
  await page.getByLabel("Email").fill("practitioner@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/patients$/);
  await page.goto("/login");
  await expect(page.getByText("practitioner@fixture.local", { exact: true })).toBeVisible();
  await page.route("**/api/auth/logout", route => route.fulfill({ status: 503, json: {} }));
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-out could not be confirmed" })).toBeVisible();
  await expect(page.getByText("practitioner@fixture.local", { exact: true })).toBeVisible();
  await page.unroute("**/api/auth/logout");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const session = await page.request.get("/api/auth/session");
  expect((await session.json()).data.signedIn).toBe(false);
});
