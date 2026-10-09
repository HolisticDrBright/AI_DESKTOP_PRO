import { test, expect, type Page } from '@playwright/test';
test.skip(process.env.E2E_RECORDING_AWS !== '1', 'Dedicated AWS recording presentation configuration required.');
// Real Chromium against the encounter page with every same-origin proxy answered by
// fictional, contract-exact responses. No provider, hosted service, consent or
// physical evidence is involved; the workforce cookie refusal is checked for real.
const encounterId = '11111111-1111-4111-8111-111111111111', recordingId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333', transcriptV1 = '44444444-4444-4444-8444-444444444444';
const transcriptV2 = '55555555-5555-4555-8555-555555555555', draftJobId = '66666666-6666-4666-8666-666666666666';
const proposedNoteId = '77777777-7777-4777-8777-777777777777', noteId = '88888888-8888-4888-8888-888888888888';
const patientId = 'aaaaaaaa-1111-2222-3333-444444444401', authorId = '99999999-9999-4999-8999-999999999999', path = `/patients/${patientId}/encounter/${encounterId}`;
const at = '2026-09-20T10:00:00.000Z', hash = 'a'.repeat(64);
const providerText = 'FICTIONAL TRANSCRIPT: patient reports fictional fatigue for two weeks.';
const correctedText = 'FICTIONAL TRANSCRIPT: patient reports fictional fatigue for three weeks.';
const transcriptionCapabilities = { transcription: true, aiDrafting: false, reason: 'ai_drafting_not_configured' };
const draftingCapabilities = { aiDrafting: true, writesClinicalNotes: false, reason: 'review_only' };
type JobStatus = 'requested' | 'processing' | 'completed' | 'failed' | 'cancelled';
type Version = { transcriptId: string; version: number; kind: 'provider' | 'correction'; contentSha256: string; byteLength: number; wordCount: number; supersedesId: string | null; authorId: string; reason: string | null; createdAt: string };
function version(transcriptId: string, n: number, text: string, reason: string | null): Version {
  return { transcriptId, version: n, kind: n === 1 ? 'provider' : 'correction', contentSha256: hash, byteLength: text.length, wordCount: text.split(/\s+/).length,
    supersedesId: n === 1 ? null : transcriptV1, authorId, reason, createdAt: at };
}
/** Fictional transcription and drafting authorities with explicit state the tests drive. */
async function fixture(page: Page, options: { initialJob?: { status: JobStatus; failureCode: string | null } | null; draftNote?: boolean } = {}) {
  const state = { job: options.initialJob === undefined ? null : options.initialJob, jobId: options.initialJob ? recordingId : jobId, versions: [] as Version[],
    texts: new Map<string, string>(), requests: [] as Record<string, unknown>[], corrections: [] as Record<string, unknown>[], refuse: null as number | null,
    draft: null as { status: 'requested' | 'completed' | 'failed'; noteType: string } | null, draftRequests: [] as Record<string, unknown>[], noteSaves: [] as Record<string, unknown>[] };
  const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/api/live/emr/encounter?*', route => route.fulfill({ json: { data: {
    encounter: { encounterId, patientId, status: 'in_progress', appointmentId: null, visitType: null, startedAt: null, endedAt: null, statusReason: null },
    notes: options.draftNote ? [{ noteId, noteType: 'soap', status: 'draft', currentVersion: 1, updatedAt: at }] : [] } } }));
  await page.route('**/api/live/emr/note?*', route => route.fulfill({ json: { data: { note: { noteId, status: 'draft', noteType: 'soap', currentVersion: 1, statusReason: null },
    content: { S: 'Existing fictional subjective text.' }, contentVersion: 1, lastSavedAt: at, signature: null, addenda: [], provenance: [] } } }));
  await page.route('**/api/live/emr/note', route => { state.noteSaves.push(route.request().postDataJSON()); return route.fulfill({ json: { data: { noteId, version: state.noteSaves.length + 1, savedAt: at } } }); });
  await page.route('**/api/live/scribe/authority', route => route.fulfill({ json: { data: { encounterId, encounterStatus: 'in_progress', activeCapture: null, consentReleases: [], participants: [],
    finishedCaptures: [{ id: recordingId, contentType: 'audio/webm', createdAt: at, finishedAt: at, deletionDeadline: '2026-09-21T10:00:00.000Z', segmentCount: 2,
      transcription: state.job && state.job.status !== 'failed' && state.job.status !== 'cancelled' ? { jobId: state.jobId, status: state.job.status } : null }] },
    capabilities: { consentManagement: true, audioCapture: false, reason: 'audio_transport_not_configured' } } }));
  const listing = () => ({ recordingId, status: 'closed', versions: state.versions, job: state.job ? { jobId: state.jobId, status: state.job.status,
    providerJobName: state.job.status === 'requested' ? null : `alp-${state.jobId}`, failureCode: state.job.failureCode, segmentCount: 2, inventorySha256: hash, createdAt: at, updatedAt: at } : null });
  await page.route('**/api/live/scribe/transcription', async route => {
    const body = route.request().postDataJSON() as { operation: string; input: Record<string, string> };
    if (state.refuse) { await route.fulfill({ status: state.refuse, json: { error: 'DO NOT RENDER RAW REFUSAL DETAIL' } }); return; }
    let data: unknown = listing();
    if (body.operation === 'request') {
      state.requests.push(body.input); state.jobId = jobId; state.job = { status: 'requested', failureCode: null };
      data = { jobId, recordingId, commandId: body.input.commandId, status: 'requested', segmentCount: 2, inventorySha256: hash, replayed: false };
    } else if (body.operation === 'advance') {
      if (state.job?.status === 'requested') state.job = { status: 'processing', failureCode: null };
      else if (state.job?.status === 'processing') { state.job = { status: 'completed', failureCode: null }; state.versions = [version(transcriptV1, 1, providerText, null)]; state.texts.set(transcriptV1, providerText); }
      data = listing();
    } else if (body.operation === 'read') {
      const text = state.texts.get(body.input.transcriptId); if (!text) { await route.fulfill({ status: 404, json: { error: 'not_found' } }); return; }
      data = { transcriptId: body.input.transcriptId, recordingId, version: state.versions.find(v => v.transcriptId === body.input.transcriptId)!.version, contentSha256: hash, text };
    } else if (body.operation === 'correct') {
      state.corrections.push(body.input); state.versions = [...state.versions, version(transcriptV2, 2, body.input.text, body.input.reason)]; state.texts.set(transcriptV2, body.input.text);
      data = listing();
    }
    await route.fulfill({ json: { data, capabilities: transcriptionCapabilities } });
  });
  const draftListing = () => ({ recordingId, status: 'closed', latestTranscript: state.versions.length ? { transcriptId: state.versions.at(-1)!.transcriptId, version: state.versions.length } : null,
    job: state.draft ? { jobId: draftJobId, status: state.draft.status, noteType: state.draft.noteType, transcriptId: state.versions.at(-1)?.transcriptId ?? transcriptV1, failureCode: state.draft.status === 'failed' ? 'provider_unavailable' : null, createdAt: at, updatedAt: at } : null,
    versions: state.draft?.status === 'completed' ? [{ proposedNoteId, version: 1, noteType: state.draft.noteType, transcriptId: state.versions.at(-1)!.transcriptId, contentSha256: hash, byteLength: 400, sectionCount: 4, model: 'fictional-model-1', createdBy: authorId, createdAt: at }] : [] });
  await page.route('**/api/live/scribe/drafting', async route => {
    const body = route.request().postDataJSON() as { operation: string; input: Record<string, string> };
    if (state.refuse) { await route.fulfill({ status: state.refuse, json: { error: 'DO NOT RENDER RAW REFUSAL DETAIL' } }); return; }
    let data: unknown = draftListing();
    if (body.operation === 'request') { state.draftRequests.push(body.input); state.draft = { status: 'requested', noteType: body.input.noteType };
      data = { jobId: draftJobId, recordingId, transcriptId: body.input.transcriptId, commandId: body.input.commandId, noteType: body.input.noteType, status: 'requested', replayed: false }; }
    else if (body.operation === 'advance') { if (state.draft?.status === 'requested') state.draft = { ...state.draft, status: 'completed' }; data = draftListing(); }
    else if (body.operation === 'read') data = { proposedNoteId, recordingId, version: 1, contentSha256: hash, document: { contract: 'proposed-note/1', noteType: state.draft!.noteType, transcriptId: state.versions.at(-1)!.transcriptId,
      transcriptSha256: hash, model: 'fictional-model-1', promptSha256: hash, sections: [{ key: 'A', label: 'Assessment', text: 'Fictional fatigue, cause not established in transcript.' }, { key: 'D', label: 'Diagnosis (nutrition)', text: '' },
        { key: 'I', label: 'Intervention', text: 'Clinician stated plan to recheck labs.' }, { key: 'ME', label: 'Monitoring & evaluation', text: 'Not stated in transcript.' }], cautions: ['FICTIONAL CAUTION: no examination findings were spoken.'] } };
    await route.fulfill({ json: { data, capabilities: draftingCapabilities } });
  });
  await page.goto(path);
  await page.getByLabel('Consent locale').fill('en-US'); await page.getByLabel('Reviewed jurisdiction').fill('FICTIONAL');
  await page.getByRole('button', { name: 'Load consent workspace' }).click();
  const transcription = page.getByRole('region', { name: `Transcription for recording finished ${at}` });
  const drafting = page.getByRole('region', { name: `Proposed documentation for recording finished ${at}` });
  await expect(transcription).toBeVisible();
  return { state, errors, transcription, drafting };
}

test('walks request, advance, open and correction as explicit steps; the correction textarea shows the opened version and the new version replaces the text on screen', async ({ page }) => {
  const f = await fixture(page);
  await f.transcription.getByRole('button', { name: 'Load transcription status' }).click();
  await expect(f.transcription.getByRole('status')).toHaveText('No transcription requested');
  await f.transcription.getByRole('button', { name: 'Request transcription', exact: true }).click();
  await expect(f.transcription.getByRole('status')).toHaveText('Transcription requested. Advance to run the next step.');
  expect(f.state.requests[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
  await f.transcription.getByRole('button', { name: 'Advance one step' }).click();
  await expect(f.transcription.getByRole('status')).toHaveText('The provider is working. Advance again to check.');
  await f.transcription.getByRole('button', { name: 'Advance one step' }).click();
  await expect(f.transcription.getByRole('status')).toHaveText('Transcript stored. Open a version to review it.');
  await expect(f.transcription.getByRole('button', { name: 'Advance one step' })).toHaveCount(0);
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveCount(0);
  await f.transcription.getByRole('button', { name: 'Open version 1' }).click();
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveText(providerText);
  const textarea = f.transcription.getByLabel('Corrected transcript');
  await expect(textarea).toHaveValue(providerText);
  await textarea.fill(correctedText); await f.transcription.getByLabel('Reason for correction').fill('duration corrected by clinician');
  await f.transcription.getByRole('button', { name: 'Store correction as a new version' }).click();
  await expect(f.transcription.getByRole('status')).toHaveText('Correction stored as a new version. Earlier versions remain unchanged.');
  // The corrected text is never shown from page memory; it must be opened from the stored version.
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveCount(0);
  await expect(f.transcription.getByText(/Version 2 · correction .* duration corrected by clinician/)).toBeVisible();
  expect(f.state.corrections).toEqual([{ recordingId, text: correctedText, reason: 'duration corrected by clinician' }]);
  await f.transcription.getByRole('button', { name: 'Open version 2' }).click();
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveText(correctedText);
  await expect(f.transcription.getByLabel('Corrected transcript')).toHaveValue(correctedText);
  // Opening the superseded version offers no correction form.
  await f.transcription.getByRole('button', { name: 'Open version 1' }).click();
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveText(providerText);
  await expect(f.transcription.getByLabel('Corrected transcript')).toHaveCount(0);
  await f.transcription.getByRole('button', { name: 'Close text' }).click();
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
test('a terminally failed job offers a new request with a fresh command, and the failed job is not merged into the new one', async ({ page }) => {
  const f = await fixture(page, { initialJob: { status: 'failed', failureCode: 'provider_unavailable' } });
  await f.transcription.getByRole('button', { name: 'Load transcription status' }).click();
  await expect(f.transcription.getByRole('status')).toHaveText('Failed — no transcript stored');
  await expect(f.transcription.getByText(/Recorded failure: provider_unavailable/)).toBeVisible();
  await expect(f.transcription.getByRole('button', { name: 'Advance one step' })).toHaveCount(0);
  const again = f.transcription.getByRole('button', { name: 'Request transcription again' });
  await again.focus(); await expect(again).toBeFocused(); await page.keyboard.press('Enter');
  await expect(f.transcription.getByRole('status')).toHaveText('Transcription requested. Advance to run the next step.');
  expect(f.state.requests).toHaveLength(1); expect(f.state.requests[0].commandId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(f.transcription.getByText(/Recorded failure/)).toHaveCount(0);
  await expect(f.transcription.getByRole('button', { name: 'Advance one step' })).toBeVisible();
  await f.transcription.getByRole('button', { name: 'Advance one step' }).click();
  await expect(f.transcription.getByRole('status')).toHaveText('The provider is working. Advance again to check.');
  expect(f.errors).toEqual([]);
});
test('opened transcript text leaves the page when a refresh is refused for authorization, and raw refusal detail is never rendered', async ({ page }) => {
  const f = await fixture(page, { initialJob: { status: 'completed', failureCode: null } });
  f.state.versions = [version(transcriptV1, 1, providerText, null)]; f.state.texts.set(transcriptV1, providerText);
  await f.transcription.getByRole('button', { name: 'Load transcription status' }).click();
  await f.transcription.getByRole('button', { name: 'Open version 1' }).click();
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveText(providerText);
  f.state.refuse = 401;
  await f.transcription.getByRole('button', { name: 'Load transcription status' }).click();
  await expect(f.transcription.getByRole('alert')).toHaveText('Sign in again to renew workforce authorization, then return to this encounter.');
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveCount(0);
  await expect(page.getByText('DO NOT RENDER RAW REFUSAL DETAIL')).toHaveCount(0);
  f.state.refuse = 503;
  await f.transcription.getByRole('button', { name: 'Load transcription status' }).click();
  await expect(f.transcription.getByRole('alert')).toHaveText('The transcription service is unavailable. Nothing was changed on this page.');
  f.state.refuse = null;
  await f.transcription.getByRole('button', { name: 'Load transcription status' }).click();
  await f.transcription.getByRole('button', { name: 'Open version 1' }).click();
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveText(providerText);
  f.state.refuse = 403;
  await f.transcription.getByRole('button', { name: 'Load transcription status' }).click();
  await expect(f.transcription.getByRole('alert')).toContainText('Transcription was refused.');
  await expect(f.transcription.getByTestId('aws-transcript-text')).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
test('a proposed note is requested from the stored transcript, opened for review, and inserted only into an explicitly opened unsigned note with provenance', async ({ page }) => {
  const f = await fixture(page, { initialJob: { status: 'completed', failureCode: null }, draftNote: true });
  f.state.versions = [version(transcriptV1, 1, providerText, null)]; f.state.texts.set(transcriptV1, providerText);
  await f.drafting.getByRole('button', { name: 'Load drafting status' }).click();
  await expect(f.drafting.getByRole('status')).toHaveText('No proposed note requested');
  await f.drafting.getByLabel('Note structure').selectOption('adime');
  await f.drafting.getByRole('button', { name: 'Request proposed note from transcript version 1' }).click();
  await expect(f.drafting.getByRole('status')).toHaveText('Proposed note requested. Advance to run the single drafting step.');
  expect(f.state.draftRequests[0]).toMatchObject({ recordingId, transcriptId: transcriptV1, noteType: 'adime' });
  await f.drafting.getByRole('button', { name: 'Run the drafting step' }).click();
  await expect(f.drafting.getByRole('status')).toHaveText('Proposed note stored. Open it to review; nothing was added to any note.');
  await f.drafting.getByRole('button', { name: 'Open proposed note 1' }).click();
  const note = f.drafting.getByTestId('aws-proposed-note');
  await expect(note.getByRole('alert')).toContainText('FICTIONAL CAUTION');
  await expect(note.getByText('Fictional fatigue, cause not established in transcript.')).toBeVisible();
  await expect(note.getByText('(nothing stated in the transcript)')).toBeVisible();
  // Without an opened unsigned note, insertion is disabled and explains why.
  const insert = note.getByRole('button', { name: 'Insert into the open unsigned note' }).first();
  await expect(insert).toBeDisabled(); await expect(insert).toHaveAttribute('title', 'Open or start an unsigned note to insert into.');
  await page.getByRole('button', { name: /SOAP/ }).first().click();
  await expect(page.locator('#section-S')).toHaveValue('Existing fictional subjective text.');
  await expect(insert).toBeEnabled();
  await insert.click();
  await expect(page.locator('#section-S')).toHaveValue('Existing fictional subjective text.\nAssessment: Fictional fatigue, cause not established in transcript.');
  await expect.poll(() => f.state.noteSaves.length).toBeGreaterThan(0);
  expect(f.state.noteSaves.at(-1)).toMatchObject({ noteId, provenance: [expect.objectContaining({ refType: 'proposed_note', refId: proposedNoteId, label: expect.stringContaining('review required') })] });
  // Nothing was written to the transcript or a signed note; the proposal itself is unchanged.
  await expect(note.getByText('Fictional fatigue, cause not established in transcript.')).toBeVisible();
  await f.drafting.getByRole('button', { name: 'Close proposed note' }).click();
  await expect(f.drafting.getByTestId('aws-proposed-note')).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
test('drafting refuses without a transcript and drops an opened proposal on authorization loss', async ({ page }) => {
  const f = await fixture(page);
  await f.drafting.getByRole('button', { name: 'Load drafting status' }).click();
  await expect(f.drafting.getByText('· no transcript stored yet')).toBeVisible();
  await expect(f.drafting.getByRole('button', { name: /Request proposed note/ })).toHaveCount(0);
  f.state.versions = [version(transcriptV1, 1, providerText, null)]; f.state.texts.set(transcriptV1, providerText); f.state.draft = { status: 'completed', noteType: 'soap' };
  await f.drafting.getByRole('button', { name: 'Load drafting status' }).click();
  await f.drafting.getByRole('button', { name: 'Open proposed note 1' }).click();
  await expect(f.drafting.getByTestId('aws-proposed-note')).toBeVisible();
  f.state.refuse = 401;
  await f.drafting.getByRole('button', { name: 'Load drafting status' }).click();
  await expect(f.drafting.getByRole('alert')).toHaveText('Sign in again to renew workforce authorization, then return to this encounter.');
  await expect(f.drafting.getByTestId('aws-proposed-note')).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
test('the real Desktop proxies refuse a browser without a workforce cookie for transcription and drafting', async ({ page }) => {
  await page.goto('/today');
  for (const route of ['/api/live/scribe/transcription', '/api/live/scribe/drafting']) {
    const result = await page.evaluate(async ([url, recordingId]) => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'list', input: { recordingId } }) });
      return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
    }, [route, recordingId] as const);
    expect(result).toMatchObject({ status: 401, data: { error: { code: 'unauthenticated' } } });
    expect(result.cache?.split(',').map(v => v.trim())).toContain('no-store');
  }
});
