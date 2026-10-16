import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An account that signed in but was never approved by a clinic: a direct Cognito sign-up, a pending or a rejected
// applicant. Its token proves who signed in and nothing else (no clinic claim, no person claim), and the session has no
// clinic selection. The real Desktop routes for the chart, messages, programs, billing, export and provider entry
// points; only the browser's cookies and headers and the network are faked. Fictional identifiers only.
const browser = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }>, headers: new Headers() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => browser.cookies.find(cookie => cookie.name === name),
    getAll: (name?: string) => (name ? browser.cookies.filter(cookie => cookie.name === name) : browser.cookies),
  }),
  headers: async () => browser.headers,
}));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));

import { NextRequest } from 'next/server';
import { POST as patientOverview } from '@/app/api/live/patients/overview/route';
import { POST as careMessages } from '@/app/api/live/care-messages/route';
import { POST as programAssignments } from '@/app/api/live/program-assignments/route';
import { POST as billingWorkspace } from '@/app/api/live/billing/workspace/route';
import { POST as privacyOperations } from '@/app/api/live/privacy-operations/route';
import { POST as telehealthStart } from '@/app/api/live/telehealth/start/route';
import { POST as scribeAuthority } from '@/app/api/live/scribe/authority/route';
import { GET as joinRequests } from '@/app/api/live/org/join-requests/route';
import { POST as labUpload } from '@/app/api/live/labs/upload/route';
import { GET as labDocument } from '@/app/api/live/labs/document/[documentId]/route';

const ORIGIN = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const HEADER = 'x-alp-selected-organization-id';
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const sub = randomUUID();
// What a direct sign-up's ID token carries: a subject and a verified address, and no clinical claim at all.
const idToken = [{ alg: 'RS256' }, { sub, token_use: 'id', email_verified: true, email: 'never.approved@applicant.fictional.example' }]
  .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fictional';
const post = (path: string, body: unknown) => new NextRequest(`http://0.0.0.0:3000${path}`, { method: 'POST',
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ENTRY_POINTS: Array<[string, () => Promise<Response>]> = [
  ['chart: patient overview', () => patientOverview(post('/api/live/patients/overview', { patientId: randomUUID() }))],
  ['messages', () => careMessages(post('/api/live/care-messages', { action: 'list' }))],
  ['programs', () => programAssignments(post('/api/live/program-assignments', { action: 'programs' }))],
  ['billing workspace', () => billingWorkspace(post('/api/live/billing/workspace', {}))],
  ['export: privacy operations', () => privacyOperations(post('/api/live/privacy-operations', { action: 'list', includeClosed: false }))],
  ['provider entry: telehealth visit start', () => telehealthStart(post('/api/live/telehealth/start', { appointmentId: randomUUID() }))],
  ['provider entry: encounter recording authority', () => scribeAuthority(post('/api/live/scribe/authority', { action: 'status', patientId: randomUUID() }))],
  ['provider entry: join-request review', () => joinRequests(new Request(`http://0.0.0.0:3000/api/live/org/join-requests`, { headers: { host } }))],
  ['chart: lab PDF upload', () => {
    const form = new FormData();
    form.set('patientId', randomUUID());
    form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'fictional-lab.pdf', { type: 'application/pdf' }));
    return labUpload(new NextRequest('http://0.0.0.0:3000/api/live/labs/upload', { method: 'POST', headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' }, body: form }));
  }],
  ['chart: original lab document', () => labDocument(new NextRequest(`http://0.0.0.0:3000/api/live/labs/document/${randomUUID()}`, { headers: { host } }),
    { params: Promise.resolve({ documentId: randomUUID() }) })],
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN', ORIGIN);
  vi.stubEnv('WORKFORCE_JOIN_REVIEW_API_ORIGIN', ORIGIN);
  vi.stubEnv('AWS_CLINICAL_API_URL', ORIGIN);
  // Every AWS service would refuse this token: it has no legacy clinic or person claim, and no current membership.
  fetchMock = vi.fn(async () => Response.json({ error: 'identity_refused' }, { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);
  browser.cookies = [{ name: 'aidp_at', value: idToken }, { name: 'aidp_exp', value: String(Date.now() + 3_600_000) },
    { name: 'aidp_em', value: 'never.approved@applicant.fictional.example' }];
  browser.headers = new Headers();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); browser.cookies = []; });

describe('an unapproved account has zero clinical access', () => {
  it('under clinic-membership sign-in, with every converted family paired: every entry point refuses and nothing leaves', async () => {
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
    vi.stubEnv('CLINICAL_CURRENT_MEMBERSHIP_FAMILIES', 'care_messages,program_assignments,workforce_join_review');
    for (const [label, call] of ENTRY_POINTS) {
      const answer = await call();
      expect([label, answer.status >= 400]).toEqual([label, true]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('under the legacy sign-in: every entry point refuses, and nothing that leaves names a clinic', async () => {
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', '');
    for (const [label, call] of ENTRY_POINTS) {
      const answer = await call();
      expect([label, answer.status >= 400]).toEqual([label, true]);
    }
    // What leaves at all goes to a service that decides by the token's claims, which this token does not have; its
    // refusal of such a token is tested in that service's own suite (aws-production-clinical-api.test.ts).
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
      expect(headers[HEADER]).toBeUndefined();
      expect(JSON.stringify(init?.body ?? '')).not.toMatch(/organization_id|organizationId/);
    }
  });
});
