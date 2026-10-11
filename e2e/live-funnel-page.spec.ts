import { expect, test } from "@playwright/test";
import { resetBackend } from "./support/backend";

/**
 * The public funnel route as a stranger reaches it: no session, no redirect to sign-in. Every
 * funnel in the repository is a draft today, so the page answers not-found for a draft and for
 * an unknown slug alike, and never the practitioner sign-in page. The route's same-origin policy
 * is served on that answer, and the neighbouring prefixes still redirect.
 */
test.skip(!process.env.E2E_LIVE, "requires the synthetic live contract fixture");
test.beforeAll(resetBackend);

test("a signed-out visitor reaches the funnel route and the consult page without being sent to sign in", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    for (const path of ["/learn/longevity-program", "/learn/no-such-program"]) {
      const response = await page.goto(`${baseURL}${path}`, { waitUntil: "domcontentloaded" });
      expect(response?.status(), path).toBe(404);
      expect(page.url(), path).not.toContain("/login");
      await expect(page.getByText("Page not found")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
      const csp = response?.headers()["content-security-policy"] ?? "";
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("frame-src 'none'");
      expect(csp, path).toContain("connect-src 'self'");
    }
    const consult = await page.goto(`${baseURL}/consult/fictional-funnel-link`, { waitUntil: "domcontentloaded" });
    expect(consult?.status()).toBe(200);
    expect(page.url()).not.toContain("/login");
  } finally { await context.close(); }
});

test("neighbouring paths are not funnel pages in the running app: the prefix alone and look-alike prefixes answer not-found", async ({ browser, baseURL }) => {
  // Whether a signed-out neighbour redirects to sign-in depends on posture: with the documented local
  // fallback session configured (as the contract-fixture suite runs), pages render instead. The exact
  // allow-list is proven without that fallback in src/middleware.test.ts. What holds in both postures is
  // that none of these paths is a funnel page.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    for (const path of ["/learn", "/learning/longevity-program", "/learn-more/longevity-program"]) {
      const response = await page.goto(`${baseURL}${path}`, { waitUntil: "domcontentloaded" });
      const landed = new URL(page.url()).pathname;
      expect(landed === "/login" || response?.status() === 404, `${path} -> ${landed} ${response?.status()}`).toBe(true);
      await expect(page.getByTestId("funnel-page")).toHaveCount(0);
    }
  } finally { await context.close(); }
});
