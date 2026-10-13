import { afterEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/live/programs/media/learner-view/route';
import { __resetStaffMediaHost, installStaffMediaHost, type StaffMediaHost } from './learner-media-staff-host';
import { LearnerMediaError } from './learner-media';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';

/** The workforce host for the learner media read is separate from the consumer host, and absent unless a reviewed bootstrap installs one. */
const ORIGIN = 'https://clinic.fictional.example';
const post = (body: unknown = { contractVersion: 'program-learner-media-staff/1' }, headers: Record<string, string> = {}) => POST(new Request(`${ORIGIN}/api/live/programs/media/learner-view`, {
  method: 'POST', headers: { host: 'clinic.fictional.example', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
const clinician: ClinicalRequestContext = { actorPersonId: '7f000000-0000-4000-8000-000000000001', organizationId: '7f000000-0000-4000-8000-000000000002', identityPool: 'workforce', identitySubject: 'wf:fictional',
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false };
afterEach(() => __resetStaffMediaHost());

describe('the staff media route', () => {
  it('answers that no workforce host is installed, and reads nothing', async () => {
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'staff_media_host_unavailable', message: 'staff_media_host_unavailable' } });
    expect(response.headers.get('cache-control')).toBe('no-store, private');
  });
  it('refuses a cross-site request before choosing a host', async () => {
    expect((await post(undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });
  it('only a reviewed host can be installed; a consumer is not a clinician; a reply for someone no longer verified is discarded', async () => {
    expect(() => installStaffMediaHost({ kind: 'fixture' } as unknown as StaffMediaHost)).toThrow('staff_media_host_must_be_reviewed');
    let who: ClinicalRequestContext | null = { ...clinician, identityPool: 'consumer' };
    installStaffMediaHost({ kind: 'reviewed', identify: async () => who, read: async () => { who = null; return { outcome: 'not_available' }; } });
    expect((await post()).status).toBe(401);
    who = clinician;
    expect((await post()).status).toBe(401);
  });
  it('maps a refused identity and an invalid body to their own answers, never to "no media"', async () => {
    installStaffMediaHost({ kind: 'reviewed', identify: async () => clinician, read: async (_c, body) => { if ((body as { bad?: boolean }).bad) throw new LearnerMediaError('request_invalid'); throw new LearnerMediaError('identity_refused'); } });
    expect((await post({ bad: true })).status).toBe(400);
    expect((await post()).status).toBe(403);
  });
});
