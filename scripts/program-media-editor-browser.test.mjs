/** Actual React panel and browser File hashing, with fictional HTTP replies.
 * SQL/SDK composition is separate evidence. Not hosted or device acceptance. */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
let browser, bundle;
before(async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ProgramMediaUploadPanel} from './src/components/programs/ProgramMediaUploadPanel';
    const root=createRoot(document.getElementById('root'));
    window.renderMedia=(changes={},disabled=false)=>root.render(<React.StrictMode><ProgramMediaUploadPanel
      scope={{programId:'11111111-1111-4111-8111-111111111111',draftId:'22222222-2222-4222-8222-222222222222',
        stepId:'phase-1/lesson-1',session:'fictional-session-1',...changes}} disabled={disabled}/></React.StrictMode>);
    window.unmountMedia=()=>root.unmount();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    jsx: 'automatic', tsconfig: resolve('tsconfig.json'), define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' } });
  bundle = result.outputFiles[0].text; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });
async function mount(t) {
  const page = await browser.newPage(); t.after(() => page.close());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /flushSync|cannot update a component/i.test(message.text())) errors.push(message.text()); });
  // A routed loopback document provides a secure context, with no real server.
  await page.route('**/*', route => route.request().url() === 'http://127.0.0.1:3919/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
  await page.goto('http://127.0.0.1:3919/');
  await page.evaluate(() => {
    const f = window.mediaFixture = { mode: 'valid', calls: [], signals: [], pending: [], reservation: null, artifact: null, manifest: null, received: [], multipartState: 'prepared' };
    const artifactId = '44444444-4444-4444-8444-444444444444', clinic = '33333333-3333-4333-8333-333333333333';
    const response = (data, contractVersion = 'program-media-control-http/1') => new Response(JSON.stringify({ contractVersion, ok: true, data }),
      { headers: { 'content-type': 'application/json' } });
    const multipartResponse = () => response({ artifactId, contentType: f.reservation.contentType, bytes: f.reservation.bytes, sha256: f.reservation.sha256,
      state: f.multipartState, acceptBefore: f.reservation.acceptBefore, receivedParts: f.received, pendingParts: [], pendingWork: f.mode === 'video-pending' }, 'program-media-multipart-control/1');
    const ready = () => { const r = f.reservation;
      return f.artifact = { artifactId, clinic, programId: r.programId, kind: r.kind, contentType: r.contentType, bytes: r.bytes, sha256: r.sha256, objectKey: r.objectKey,
        version: 1, state: 'ready', objectVersion: 'fictional-v1', committedAt: new Date().toISOString(), retiredAt: null, failure: null, caption: null, transcript: null };
    };
    window.fetch = async (url, options) => {
      f.signals.push(options.signal);
      const command = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      f.calls.push({ url, method: options.method, command, bytes: command ? 0 : options.body.byteLength });
      if (f.mode === 'denied' || f.mode === 'disabled') return new Response(JSON.stringify({ contractVersion: 'program-media-control-http/1', ok: false,
        error: { code: f.mode === 'denied' ? 'access_refused' : 'program_media_disabled' } }),
        { status: f.mode === 'denied' ? 403 : 503, headers: { 'content-type': 'application/json' } });
      if (String(url).endsWith('/multipart/control')) {
        if (command.operation === 'status' || command.operation === 'reconcile') {
          if (!f.manifest) return new Response(JSON.stringify({ contractVersion: 'program-media-multipart-control/1', ok: false, error: { code: 'not_found' } }),
            { status: 404, headers: { 'content-type': 'application/json' } });
          return multipartResponse();
        }
        if (command.operation === 'start') { f.manifest = command.request.manifest; return multipartResponse(); }
        if (command.operation === 'create') { f.multipartState = 'uploading'; return multipartResponse(); }
        if (command.operation === 'complete') { f.multipartState = 'committed'; ready(); return multipartResponse(); }
        throw new Error('unexpected fictional multipart command');
      }
      if (String(url).includes('/multipart/part/')) { f.received.push(Number(String(url).split('/').at(-2))); return multipartResponse(); }
      if (command?.operation === 'prepare') {
        const q = command.request;
        f.reservation = { artifactId, clinic, programId: q.programId, kind: q.kind, contentType: q.contentType, bytes: q.bytes, sha256: q.sha256,
          objectKey: 'program-media/' + clinic + '/' + q.programId + '/' + artifactId + '/' + q.sha256 + (q.kind === 'video' ? '.mp4' : '.png'), commandId: q.commandId,
          state: 'reserved', acceptBefore: new Date(Date.now() + 600000).toISOString(), createdAt: new Date().toISOString(), replayed: false, failure: null };
        if (f.mode === 'prepare-pending') await new Promise(done => f.pending.push(done));
        if (f.mode === 'prepare-lost') { f.mode = 'valid'; throw new Error('fictional lost preparation reply'); }
        return response(f.reservation);
      }
      if (String(url).includes('/media/image/')) {
        ready();
        if (f.mode === 'image-lost') { f.mode = 'valid'; throw new Error('fictional lost reply after commit'); }
        return response(f.artifact, 'program-media-image-http/1');
      }
      if (command?.operation === 'inspect') return response(f.artifact ?? f.reservation);
      if (command?.operation === 'attachText') {
        const q = command.request, hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(q.text));
        const sha256 = [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
        f.artifact = { ...f.artifact, version: f.artifact.version + 1, caption: { text: q.text, source: q.source, format: q.format, sha256 } };
        return response(f.artifact);
      }
      if (command?.operation === 'publish') {
        const a = f.artifact;
        return response({ contractVersion: 'program-media-reference/1', artifactId, version: a.version, sha256: a.sha256, kind: a.kind, contentType: a.contentType,
          bytes: a.bytes, origin: { clinic, programId: a.programId }, url: 'https://education.example.test/exact-reference', publishedAt: new Date().toISOString(),
          caption: { source: a.caption.source, sha256: a.caption.sha256 }, transcript: null });
      }
      if (command?.operation === 'preview') {
        const a = f.artifact;
        if (f.mode === 'preview-pending') await new Promise(done => f.pending.push(done));
        return response({ artifactId, version: a.version, state: 'ready', kind: a.kind, contentType: a.contentType, bytes: a.bytes, sha256: a.sha256,
          previewToken: 'https://fictional-education.s3.us-east-2.amazonaws.com/' + a.objectKey + '?versionId=fictional-v1',
          previewUntil: new Date(Date.now() + (f.mode === 'preview-expiry' ? 100 : 290000)).toISOString(), historical: false });
      }
      throw new Error('unexpected fictional browser transport');
    };
  });
  await page.addScriptTag({ content: bundle }); assert.deepEqual(errors, []); await page.evaluate(() => window.renderMedia());
  await page.getByTestId('program-media-upload-panel').waitFor();
  t.after(() => assert.deepEqual(errors, [])); return page;
}
async function choose(page) {
  await page.getByLabel('Choose educational media file').setInputFiles({ name: 'lesson.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Upload or resume')?.disabled);
}
async function upload(page) {
  await choose(page); await page.getByRole('button', { name: 'Upload or resume', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Private author preview')?.disabled);
}
test('StrictMode image flow confirms receipts and keeps patient delivery separate', async t => {
  const page = await mount(t); await upload(page);
  assert.match(await page.locator('body').innerText(), /1 of 1 parts confirmed/);
  assert.equal(await page.getByRole('button', { name: 'Publish exact media reference' }).isDisabled(), true);
  await page.getByLabel('Supplied educational media caption').fill('Fictional supplied explanation');
  await page.getByRole('button', { name: 'Save supplied caption' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Publish exact media reference')?.disabled);
  await page.getByRole('button', { name: 'Publish exact media reference' }).click();
  await page.getByText(/Published artifact .* Patient delivery stays held/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.mediaFixture.calls.map(c => c.command?.operation ?? 'binary')), ['prepare', 'binary', 'attachText', 'publish']);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
});
test('lost upload receipt recovers through status, never an automatic second write', async t => {
  const page = await mount(t); await page.evaluate(() => { window.mediaFixture.mode = 'image-lost'; }); await choose(page);
  await page.getByRole('button', { name: 'Upload or resume' }).click();
  await page.getByRole('status').filter({ hasText: 'could not be confirmed' }).waitFor();
  assert.match(await page.locator('body').innerText(), /0 of 1 parts confirmed/);
  await page.getByRole('button', { name: 'Check saved status' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Private author preview')?.disabled);
  assert.equal(await page.evaluate(() => window.mediaFixture.calls.filter(c => c.method === 'PUT').length), 1);
});

test('lost preparation reply leaves an explicit retry using the same command', async t => {
  const page = await mount(t); await page.evaluate(() => { window.mediaFixture.mode = 'prepare-lost'; }); await choose(page);
  await page.getByRole('button', { name: 'Upload or resume' }).click();
  await page.getByRole('status').filter({ hasText: 'could not be confirmed' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Upload or resume' }).isDisabled(), false);
  assert.equal(await page.evaluate(() => window.mediaFixture.calls.length), 1);
  await page.getByRole('button', { name: 'Upload or resume' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Private author preview')?.disabled);
  const calls = await page.evaluate(() => window.mediaFixture.calls);
  assert.equal(calls[0].command.request.commandId, calls[1].command.request.commandId);
  assert.deepEqual(calls.map(c => c.command?.operation ?? 'binary'), ['prepare', 'prepare', 'binary']);
});
for (const change of ['workforce', 'cross-tab', 'hidden', 'program', 'disabled']) test(`${change} clears private state and ignores a late prepare`, async t => {
  const page = await mount(t); await page.evaluate(() => { window.mediaFixture.mode = 'prepare-pending'; });
  await choose(page); await page.getByRole('button', { name: 'Upload or resume' }).click();
  await page.waitForFunction(() => window.mediaFixture.pending.length === 1);
  await page.evaluate(change => {
    if (change === 'workforce') window.dispatchEvent(new Event('alp-workforce-session-change'));
    else if (change === 'cross-tab') window.dispatchEvent(new StorageEvent('storage', { key: 'alp-workforce-session-change' }));
    else if (change === 'hidden') { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }
    else if (change === 'program') window.renderMedia({ programId: '55555555-5555-4555-8555-555555555555' });
    else window.renderMedia({}, true);
  }, change);
  await page.waitForFunction(() => window.mediaFixture.signals.every(signal => signal.aborted));
  await page.evaluate(() => window.mediaFixture.pending.splice(0).forEach(done => done()));
  assert.equal(await page.getByLabel('Choose educational media file').inputValue(), '');
  assert.equal(await page.getByLabel('Saved media upload ID').inputValue(), '');
  assert.equal(await page.getByLabel('Supplied educational media caption').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Upload or resume' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.mediaFixture.calls.length), 1);
  assert.doesNotMatch(await page.locator('body').innerText(), /Save this upload ID/);
});
test('a new lesson drops a previous private caption and saved ID', async t => {
  const page = await mount(t); await upload(page);
  await page.getByLabel('Supplied educational media caption').fill('Private fictional draft caption');
  await page.getByLabel('Saved media upload ID').fill('44444444-4444-4444-8444-444444444444');
  await page.evaluate(() => window.renderMedia({ stepId: 'different-phase/different-lesson' }));
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
  assert.equal(await page.getByLabel('Saved media upload ID').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Private author preview' }).isDisabled(), true);
});

test('a current server authorization refusal drops all private form fields before another attempt', async t => {
  const page = await mount(t); await upload(page);
  await page.getByLabel('Supplied educational media caption').fill('Private fictional explanation');
  await page.getByLabel('Saved media upload ID').fill('44444444-4444-4444-8444-444444444444');
  await page.evaluate(() => { window.mediaFixture.mode = 'denied'; });
  await page.getByRole('button', { name: 'Private author preview' }).click();
  await page.getByRole('status').filter({ hasText: 'workforce access changed' }).waitFor();
  assert.equal(await page.getByLabel('Choose educational media file').inputValue(), '');
  assert.equal(await page.getByLabel('Saved media upload ID').inputValue(), '');
  assert.equal(await page.getByLabel('Supplied educational media caption').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Private author preview' }).isDisabled(), true);
  assert.doesNotMatch(await page.locator('body').innerText(), /Save this upload ID|Private fictional explanation/);
});

for (const change of ['workforce', 'cross-tab', 'hidden']) test(`${change} synchronously purges an opened private form before returning from the withdrawal event`, async t => {
  const page = await mount(t); await upload(page);
  await page.getByLabel('Supplied educational media caption').fill('Private fictional explanation');
  await page.getByLabel('Saved media upload ID').fill('44444444-4444-4444-8444-444444444444');
  await page.evaluate(() => { window.mediaFixture.mode = 'preview-pending'; });
  await page.getByRole('button', { name: 'Private author preview' }).click();
  await page.waitForFunction(() => window.mediaFixture.pending.length === 1);
  const immediate = await page.evaluate(change => {
    if (change === 'workforce') window.dispatchEvent(new Event('alp-workforce-session-change'));
    else if (change === 'cross-tab') window.dispatchEvent(new StorageEvent('storage', { key: 'alp-workforce-session-change' }));
    else { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }
    return { file: document.querySelector('input[type=file]').value, caption: document.querySelector('textarea').value,
      saved: document.querySelector('input[aria-label="Saved media upload ID"]').value,
      preview: document.querySelector('img,video') !== null };
  }, change);
  assert.deepEqual(immediate, { file: '', caption: '', saved: '', preview: false });
  await page.evaluate(() => window.mediaFixture.pending.splice(0).forEach(done => done()));
  assert.equal(await page.locator('img,video').count(), 0);
});
test('preview expiry removes the capability but retains the confirmed artifact', async t => {
  const page = await mount(t); await upload(page); await page.evaluate(() => { window.mediaFixture.mode = 'preview-expiry'; });
  await page.getByRole('button', { name: 'Private author preview' }).click();
  await page.getByRole('status').filter({ hasText: 'private preview expired' }).waitFor();
  assert.equal(await page.getByAltText('Private educational image preview').count(), 0);
  assert.match(await page.locator('body').innerText(), /Save this upload ID/);
  assert.equal(await page.getByRole('button', { name: 'Private author preview' }).isDisabled(), false);
});
test('unmount aborts work without preparing a replacement', async t => {
  const page = await mount(t); await page.evaluate(() => { window.mediaFixture.mode = 'prepare-pending'; }); await choose(page);
  await page.getByRole('button', { name: 'Upload or resume' }).click(); await page.waitForFunction(() => window.mediaFixture.pending.length === 1);
  await page.evaluate(() => window.unmountMedia()); await page.waitForFunction(() => window.mediaFixture.signals.every(s => s.aborted));
  await page.evaluate(() => window.mediaFixture.pending.splice(0).forEach(done => done()));
  assert.equal(await page.locator('#root').innerText(), ''); assert.equal(await page.evaluate(() => window.mediaFixture.calls.length), 1);
});
test('uninstalled host reports unavailable, never success', async t => {
  const page = await mount(t); await page.evaluate(() => { window.mediaFixture.mode = 'disabled'; }); await choose(page);
  await page.getByRole('button', { name: 'Upload or resume' }).click();
  await page.getByRole('status').filter({ hasText: 'not enabled' }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /Save this upload ID|Published artifact/);
});
test('video controls send bounded binary chunks and count only returned part receipts', async t => {
  const page = await mount(t);
  await page.getByLabel('Choose educational media file').setInputFiles({ name: 'lesson.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(8388608 + 7, 37) });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Upload or resume')?.disabled);
  await page.getByRole('button', { name: 'Upload or resume' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Private author preview')?.disabled);
  assert.match(await page.locator('body').innerText(), /2 of 2 parts confirmed/);
  assert.deepEqual(await page.evaluate(() => window.mediaFixture.calls.filter(c => c.method === 'PUT').map(c => c.bytes)), [8388608, 7]);
  assert.deepEqual(await page.evaluate(() => window.mediaFixture.calls.map(c => c.command?.operation ?? 'binary')), ['prepare', 'status', 'start', 'create', 'binary', 'binary', 'complete', 'inspect']);
  await page.getByRole('button', { name: 'Private author preview' }).click();
  await page.getByLabel('Private author video preview').waitFor();
  assert.equal(await page.getByLabel('Private author video preview').getAttribute('preload'), 'none');
  // These are deliberately fictional bytes; mounted controls are evidence,
  // not a claim that this file is a playable codec or a real S3 video.
});
