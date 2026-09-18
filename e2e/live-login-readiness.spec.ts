import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

test.skip(!process.env.E2E_LIVE, "requires the synthetic live contract fixture");
test.beforeAll(resetBackend);

test("sign-in cannot accept input or submit until its client handler is ready", async ({ page }, testInfo) => {
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>(resolve => { releaseScripts = resolve; });
  const errors: string[] = [];
  let loginPosts = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/auth/login" && request.method() === "POST") loginPosts++;
  });
  await page.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, async route => {
    await scriptsReady;
    await route.continue();
  });
  try {
    await page.goto("/login", { waitUntil: "commit" });
    await expect(page.getByText("Preparing secure sign-in.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeDisabled();
    await expect(page.getByLabel("Password")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Forgot password/ })).toBeDisabled();
    expect(loginPosts).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("sign-in-preparing.png") });
  } finally { releaseScripts(); }
  await expect(page.getByLabel("Email")).toBeEditable();
  await page.getByLabel("Email").fill("no-orgs@fixture.local");
  await page.getByLabel("Password").fill("fixture-password");
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/login" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(/\/today$/);
  expect(loginPosts).toBe(1);
  expect(errors).toEqual([]);
});

test("JavaScript-disabled sign-in stays noninteractive with an explicit explanation", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/login`);
    await expect(page.getByText("enable JavaScript and reload this page.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeDisabled();
    await expect(page.getByLabel("Password")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
  } finally { await context.close(); }
});
