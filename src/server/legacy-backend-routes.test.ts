import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The routes the route-authority inventory files under the transitional backend: the scribe harness (chunk, consent,
// recording, transcript) and the lab-document pair (PDF upload, original-document read). The real route handlers; only
// the browser's cookies and headers and the network are faked. Fictional identifiers only.
const browser = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }>, headers: new Headers() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => browser.cookies.find(cookie => cookie.name === name),
    getAll: (name?: string) => (name ? browser.cookies.filter(cookie => cookie.name === name) : browser.cookies),
  }),
  headers: async () => browser.headers,
}));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
// The transitional host is fixed when the config module loads, as it is in a deployed process.
vi.hoisted(() => { process.env.TRPC_BASE_URL = 'https://transitional-backend.fictional.example/api/trpc'; });

import { NextRequest } from 'next/server';
import { POST as scribeChunk } from '@/app/api/live/scribe/chunk/route';
import { GET as scribeConsentRead, POST as scribeConsent } from '@/app/api/live/scribe/consent/route';
import { GET as scribeRecordingRead, PATCH as scribeRecordingPatch, POST as scribeRecording } from '@/app/api/live/scribe/recording/route';
import { GET as scribeTranscriptRead, POST as scribeTranscript } from '@/app/api/live/scribe/transcript/route';
import { POST as labUpload } from '@/app/api/live/labs/upload/route';
import { GET as labDocument } from '@/app/api/live/labs/document/[documentId]/route';
import { selectedClinicCookieValues } from '@/server/selected-clinic-binding';

const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const LEGACY_HOST = 'https://transitional-backend.fictional.example';
const clinic = randomUUID();
const sub = randomUUID();
// An already-issued ID token: a member's session, signed in before anything about the clinic changed.
const idToken = [{ alg: 'RS256' }, { sub, token_use: 'id', email_verified: true, email: 'practitioner@clinic.fictional.example' }]
  .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fictional';
const at = (path: string) => `http://0.0.0.0:3000${path}`;
const json = (method: string, path: string, body: unknown) => new NextRequest(at(path), { method,
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => new NextRequest(at(path), { headers: { host } });
const recordingId = randomUUID();
const encounterId = randomUUID();

/** Every scribe entry point, each with input that passes the route's own validation, so the gate is what answers. */
const SCRIBE: Array<[string, () => Promise<Response>]> = [
  ['chunk', () => scribeChunk(new NextRequest(at('/api/live/scribe/chunk'), { method: 'POST',
    headers: { host, 'x-recording-id': recordingId, 'x-capture-token': 'fictional-capture-token', 'content-type': 'application/octet-stream', 'content-length': '4' },
    body: new Uint8Array([1, 2, 3, 4]) }))],
  ['consent read', () => scribeConsentRead(get(`/api/live/scribe/consent?encounterId=${encounterId}`))],
  ['consent: add participant', () => scribeConsent(json('POST', '/api/live/scribe/consent',
    { action: 'addParticipant', encounterId, kind: 'patient', displayName: 'Fictional Patient' }))],
  ['recording read', () => scribeRecordingRead(get(`/api/live/scribe/recording?encounterId=${encounterId}`))],
  ['recording begin', () => scribeRecording(json('POST', '/api/live/scribe/recording', { encounterId, contentType: 'audio/webm' }))],
  ['recording deletion', () => scribeRecordingPatch(json('PATCH', '/api/live/scribe/recording', { action: 'requestDeletion', recordingId }))],
  ['transcript read', () => scribeTranscriptRead(get(`/api/live/scribe/transcript?recordingId=${recordingId}`))],
  ['transcript finalize', () => scribeTranscript(json('POST', '/api/live/scribe/transcript', { action: 'finalize', transcriptId: randomUUID() }))],
];

function labUploadRequest() {
  const form = new FormData();
  form.set('patientId', randomUUID());
  form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'fictional-lab.pdf', { type: 'application/pdf' }));
  return new NextRequest(at('/api/live/labs/upload'), { method: 'POST', headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' }, body: form });
}
const LAB: Array<[string, () => Promise<Response>]> = [
  ['lab PDF upload', () => labUpload(labUploadRequest())],
  ['original lab document read', () => labDocument(get(`/api/live/labs/document/${randomUUID()}`), { params: Promise.resolve({ documentId: randomUUID() }) })],
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // A deployed process: the contract fixture is not enabled, and its backend would not be loopback anyway.
  vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '');
  vi.stubEnv('CLINICAL_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
  vi.stubEnv('RECORDING_AWS_API_ORIGIN', '');
  vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', '');
  fetchMock = vi.fn(async () => Response.json({ data: { ok: true } }));
  vi.stubGlobal('fetch', fetchMock);
  const selection = selectedClinicCookieValues(clinic, idToken)!;
  browser.cookies = [{ name: 'aidp_at', value: idToken }, { name: 'aidp_exp', value: String(Date.now() + 3_600_000) },
    { name: 'aidp_em', value: 'practitioner@clinic.fictional.example' },
    { name: 'aidp_org', value: selection.organization }, { name: 'aidp_org_sub', value: selection.binding }];
  browser.headers = new Headers();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); browser.cookies = []; });

describe('the transitional scribe routes', () => {
  it.each(['legacy_claims', 'database_current'])('under %s on a deployment: every entry point refuses before any request', async mode => {
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', mode === 'legacy_claims' ? '' : mode);
    for (const [label, call] of SCRIBE) {
      const answer = await call();
      const body = await answer.json() as { error?: { code?: string; message?: string } };
      expect([label, answer.status, body.error?.message]).toEqual([label, 503, 'AWS encounter audio capture is not available on this deployment.']);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with an AWS recording origin configured, even where the local fixture is allowed: refused, nothing sent', async () => {
    vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1');
    vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999');
    vi.stubEnv('RECORDING_AWS_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
    for (const [label, call] of SCRIBE) expect([label, (await call()).status]).toEqual([label, 503]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: only the local contract fixture reaches the harness at all', async () => {
    vi.stubEnv('CLINICAL_CONTRACT_FIXTURE', '1');
    vi.stubEnv('CLINICAL_SUPABASE_URL', 'http://127.0.0.1:3999');
    await scribeConsentRead(get(`/api/live/scribe/consent?encounterId=${encounterId}`));
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/transitional-backend\.fictional\.example\//);
  });
});

describe('lab upload and the original lab document', () => {
  it('under clinic-membership sign-in: refused before the token leaves, because the transitional host decides by the token alone', async () => {
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
    for (const [label, call] of LAB) {
      const answer = await call();
      const body = await answer.json() as { error?: { code?: string; message?: string; detail?: string } };
      expect([label, answer.status]).toEqual([label, 503]);
      expect(JSON.stringify(body), label).toContain('not available yet under clinic-membership sign-in');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('under the legacy sign-in: the token goes to the transitional host and no clinic does', async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: { code: 'forbidden', message: 'Not permitted.' } }, { status: 403 }));
    for (const [label, call] of LAB) {
      const answer = await call();
      expect([label, answer.status >= 400]).toEqual([label, true]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url.startsWith(`${LEGACY_HOST}/api/clinical/labs/`)).toBe(true);
      expect(url).not.toContain(clinic);
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
      expect(headers.authorization).toBe(`Bearer ${idToken}`);
      expect(headers['x-alp-selected-organization-id']).toBeUndefined();
      const body = init.body instanceof FormData ? [...init.body.keys()] : [];
      expect(body.filter(key => /organi[sz]ation|clinic/i.test(key))).toEqual([]);
    }
  });
});
