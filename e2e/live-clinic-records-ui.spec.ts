import { test, expect } from '@playwright/test';
import { resetBackend } from './support/backend';
// Browser presentation contract only: fictional HTTP responses for the clinic-records
// workforce route. Authority, disclosure releases, idempotent decisions and the
// append-only amendment are exercised by clinic-record-privacy.database.test.
const requestId = '11111111-1111-4111-8111-111111111111', patient = '22222222-2222-4222-8222-222222222222', note = '33333333-3333-4333-8333-333333333333';
const copy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ requestId, kind: 'copy', status: 'submitted', revision: 1, sections: ['signed_notes', 'correspondence'], subject: null, reasonCode: null, statement: null,
  submittedAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z', decidedAt: null, decisionReasonCode: null, decisionReason: null, fulfillmentId: null, supersededBy: null, outcome: null, patientRecordId: patient, ...over });
const preview = [{ section: 'signed_notes', readable: true, exclusionReason: null, includable: 2, excluded: { unsigned_not_disclosable: 1 } },
  { section: 'correspondence', readable: false, exclusionReason: 'available_through_care_message_export', includable: 0, excluded: {} }];
const event = (seq: number, action: string, actorPool: string, toStatus: string) => ({ seq, action, actorPool, fromStatus: null, toStatus, reasonCode: null, reason: null, decisionId: null, detail: {}, at: '2026-10-10T10:00:00.000Z' });
const release = { releaseVersion: 'fictional-review-1', sections: ['signed_notes'], approvedAt: '2026-10-10T00:00:00.000Z' };

test.beforeAll(async () => { await resetBackend(); });

test('a copy request is reviewed, cannot be prepared without a release, then is prepared under a fictional release with the same decision id on retry', async ({ page }, info) => {
  const calls: Record<string, unknown>[] = [], errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  let current = copy(), released = false, failFulfilOnce = true;
  await page.route('**/api/live/clinic-records', async route => {
    const { request } = route.request().postDataJSON(); calls.push(request);
    if (request.action === 'queue') return route.fulfill({ json: { data: { action: 'queue', requests: [current], next: null } } });
    if (request.action === 'review') return route.fulfill({ json: { data: { action: 'review', request: current, events: [event(1, 'submitted', 'consumer', 'submitted')], preview, subjectNote: null, release: released ? release : null, copy: null } } });
    if (request.action === 'begin_review') { current = copy({ status: 'in_review', revision: 2 }); return route.fulfill({ json: { data: { action: 'begin_review', request: current, alreadyApplied: false } } }); }
    if (request.action === 'fulfill') {
      if (!released) return route.fulfill({ status: 409, json: { error: 'disclosure_release_required' } });
      if (failFulfilOnce) { failFulfilOnce = false; return route.fulfill({ status: 503, json: { error: 'service_unavailable' } }); }
      current = copy({ status: 'fulfilled', revision: 3, outcome: 'copy_delivered', decidedAt: '2026-10-10T11:00:00.000Z' });
      return route.fulfill({ json: { data: { action: 'fulfill', request: current, alreadyApplied: false } } });
    }
    return route.fulfill({ status: 400, json: { error: 'request_invalid' } });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/inbox');
  await expect(page.getByTestId('clinic-record-row')).toHaveCount(1);
  await expect(page.getByText('Submitted — not yet reviewed')).toBeVisible();
  await page.getByRole('button', { name: 'Mark in review' }).click();
  await expect(page.getByTestId('clinic-record-review')).toContainText('In review');
  await expect(page.getByTestId('clinic-record-no-release')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare the copy under the release' })).toBeDisabled();
  // The owner's review registers a fictional release; the first attempt loses its response, the retry replays the same decision id.
  released = true;
  await page.getByRole('button', { name: 'Review request' }).click();
  await expect(page.getByTestId('clinic-record-release')).toContainText('fictional-review-1');
  await page.getByRole('button', { name: 'Prepare the copy under the release' }).click();
  await expect(page.getByTestId('clinic-record-error')).toContainText('Nothing was decided');
  await page.getByRole('button', { name: 'Prepare the copy under the release' }).click();
  await expect(page.getByText('Decided and closed (1)')).toBeVisible();
  const fulfils = calls.filter(c => c.action === 'fulfill');
  expect(fulfils).toHaveLength(2); expect(fulfils[0]).toEqual(fulfils[1]);
  expect(fulfils[0]).toMatchObject({ expectedRevision: 2, sections: ['signed_notes'], excluded: [{ section: 'correspondence', reason: 'available_through_care_message_export' }] });
  await expect(page.getByTestId('clinic-record-empty')).toBeVisible();
  await page.screenshot({ path: info.outputPath('clinic-record-copy-fulfilled.png'), fullPage: true });
  // Keyboard: the refresh control is reachable and operable without a pointer.
  await page.getByTestId('clinic-record-queue').getByRole('button', { name: 'Refresh' }).focus(); await page.keyboard.press('Enter');
  expect(calls.filter(c => c.action === 'queue').length).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('a correction is accepted only as an append-only addendum with written words; lost authorization removes the patient text', async ({ page }) => {
  const calls: Record<string, unknown>[] = [];
  let current = copy({ kind: 'correction', sections: [], subject: { kind: 'clinical_note', id: note, revision: 1 }, reasonCode: 'not_true_of_me', statement: 'Fictional: I never had this.' });
  let revoked = false;
  await page.route('**/api/live/clinic-records', async route => {
    const { request } = route.request().postDataJSON(); calls.push(request);
    if (revoked) return route.fulfill({ status: 401, json: { error: 'reauth_required' } });
    if (request.action === 'queue') return route.fulfill({ json: { data: { action: 'queue', requests: [current], next: null } } });
    if (request.action === 'review') return route.fulfill({ json: { data: { action: 'review', request: current, events: [event(1, 'submitted', 'consumer', 'submitted')], preview: null, subjectNote: { noteId: note, status: 'signed', currentVersion: 1, signedAt: '2026-10-09T00:00:00.000Z', addenda: 0 }, release: null, copy: null } } });
    if (request.action === 'amend') { current = { ...current, status: 'fulfilled', revision: 2, outcome: 'amended', fulfillmentId: '44444444-4444-4444-8444-444444444444' }; return route.fulfill({ json: { data: { action: 'amend', request: current, alreadyApplied: false, addendumId: '44444444-4444-4444-8444-444444444444' } } }); }
    return route.fulfill({ status: 400, json: { error: 'request_invalid' } });
  });
  // An empty addendum is not a decision: dismissing the prompt sends nothing.
  page.once('dialog', dialog => dialog.dismiss());
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Review request' }).click();
  await expect(page.getByTestId('clinic-record-subject')).toContainText('never rewritten');
  await page.getByRole('button', { name: 'Accept: add an addendum' }).click();
  expect(calls.some(c => c.action === 'amend')).toBe(false);
  page.on('dialog', dialog => dialog.accept('Fictional addendum: the statement is withdrawn by the clinician.'));
  await page.getByRole('button', { name: 'Accept: add an addendum' }).click();
  await expect(page.getByTestId('clinic-record-settled')).toContainText('Fulfilled · amended');
  expect(calls.filter(c => c.action === 'amend')[0]).toMatchObject({ expectedRevision: 1, addendumReason: 'Patient correction request accepted', addendumContent: 'Fictional addendum: the statement is withdrawn by the clinician.' });
  // Authorization lost: the patient's words leave the screen and the refusal is named.
  revoked = true;
  await page.getByTestId('clinic-record-queue').getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('clinic-record-error')).toContainText('Sign out and sign in again');
  await expect(page.getByText('Fictional: I never had this.')).toHaveCount(0);
  await expect(page.getByTestId('clinic-record-review')).toHaveCount(0);
});
