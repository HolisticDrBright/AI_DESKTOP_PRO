import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

// Read-only, isolated browser. No stored session, credentials, form submission,
// invitation, real record or fixture backend is used by this hosted check.
const origin = 'https://penrnyupn3.us-east-2.awsapprunner.com';
const health = await fetch(origin + '/api/health', { redirect: 'error' });
assert.equal(health.status, 200, 'hosted health');
assert.equal((await health.json()).ok, true);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let pageErrors = 0, consoleErrors = 0, blockedWrites = 0;
  page.on('pageerror', () => pageErrors++);
  page.on('console', message => { if (message.type() === 'error') consoleErrors++; });
  await page.route('**/*', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      blockedWrites++; await route.abort(); return;
    }
    await route.continue();
  });
  const session = await context.request.get(origin + '/api/auth/session');
  assert.equal(session.status(), 200);
  assert.equal((await session.json()).data.signedIn, false, 'isolated signed-out session');
  for (const path of ['/login', '/patients', '/calendar']) {
    const response = await page.goto(origin + path, { waitUntil: 'networkidle', timeout: 45000 });
    assert.equal(response.status(), 200);
    assert.equal(new URL(page.url()).pathname, '/login', 'protected navigation redirects to login');
    await page.getByRole('heading', { name: 'Practitioner sign-in', exact: true }).waitFor();
    const body = await page.locator('body').innerText();
    assert.match(body, /STAGING ENVIRONMENT.*SYNTHETIC DATA ONLY/);
    assert.ok(!body.includes('Signed-in practitioner'), 'no fabricated signed-in subtitle');
    assert.equal(await page.locator('[data-nextjs-dialog], .vite-error-overlay').count(), 0);
  }
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('link', { name: 'Practitioner sign-in', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Practitioner sign-in', exact: true }).click();
  await page.getByRole('heading', { name: 'Practitioner sign-in', exact: true }).waitFor();
  assert.equal(blockedWrites, 0, 'no attempted mutations');
  assert.equal(pageErrors, 0, 'no page exceptions');
  assert.equal(consoleErrors, 0, 'no browser console errors');
  const directory = resolve('test-results/hosted-synthetic-shell');
  await mkdir(directory, { recursive: true });
  const screenshot = resolve(directory, 'login.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ status: 'passed', paths: ['/login', '/patients', '/calendar'],
    signedOut: true, pageErrors, consoleErrors, blockedWrites, screenshot }));
} finally { await browser.close(); }
