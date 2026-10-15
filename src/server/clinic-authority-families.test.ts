import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Desktop caller families under the `database_current` authority: converted, intentionally independent, or
// refused before any token leaves the process. The real callers, with only the session, the live-mode switch and the
// network faked. Fictional identifiers only.
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));

import { recordingAuthorityRequest } from '@/adapters/recording-authority.server';
import { recordingCaptureRequest } from '@/adapters/recording-capture.server';
import { recordingCleanupExecutionRequest } from '@/adapters/recording-cleanup-execution.server';
import { recordingCleanupReviewRequest } from '@/adapters/recording-cleanup-review.server';
import { recordingDraftingRequest } from '@/adapters/recording-drafting.server';
import { recordingTranscriptionRequest } from '@/adapters/recording-transcription.server';
import { calendarWorkforceCall, CalendarWorkforceError } from '@/app/api/live/calendar-connection/workforce';
import { POST as careMessages } from '@/app/api/live/care-messages/route';
import { POST as notificationSettings } from '@/app/api/live/patient-notification-settings/route';
import { POST as programAssignments } from '@/app/api/live/program-assignments/route';
import { getAskAlpConfiguration } from '@/server/clinical-core/ask-alp-workforce-client';
import { requestPrivacyOperation } from '@/server/clinical-core/privacy-operations-client';
import { getSyntheticClinicalCorePosture, issueSyntheticPatientInvitation } from '@/server/clinical-core/synthetic-api-client';
import { consultLinkCall, clinicRecordsWorkforceCall } from '@/server/consult/consultWorkforceApi';
import { labAttestationReviewUpstream, labAttestationUpstream } from '@/server/lab-attestation-upstream';
import { campaignApiCall } from '@/server/campaign-api';
import { CLINIC_MEMBERSHIP_REFUSAL, CURRENT_MEMBERSHIP_GATED_FAMILIES, UNCONVERTED_CLINIC_FAMILIES } from './clinic-authority-families';

const API = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const TOKEN = 'fictional-workforce-token';
const LONG_TOKEN = `${'a'.repeat(40)}.${'b'.repeat(60)}.${'c'.repeat(40)}`;
const upstream = vi.fn();
const route = (path: string, body: unknown) => new Request(`http://0.0.0.0:3000${path}`, { method: 'POST',
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const refusedAdapter = { name: 'AdapterError', code: 'unavailable', detail: CLINIC_MEMBERSHIP_REFUSAL };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', upstream);
  for (const name of ['CLINICAL_AWS_WORKFORCE_API_ORIGIN', 'CLINICAL_AWS_API_ORIGIN', 'CLINICAL_AWS_PRIVACY_OPERATIONS_ORIGIN', 'RECORDING_AWS_API_ORIGIN',
    'RECORDING_CAPTURE_AWS_API_ORIGIN', 'RECORDING_DRAFTING_AWS_API_ORIGIN', 'RECORDING_TRANSCRIPTION_AWS_API_ORIGIN',
    'RECORDING_CLEANUP_EXECUTION_API_ORIGIN', 'RECORDING_CLEANUP_REVIEW_API_ORIGIN', 'CAMPAIGN_API_ORIGIN']) vi.stubEnv(name, API);
  vi.stubEnv('CLINICAL_AWS_RUNTIME_MODE', 'synthetic');
  vi.stubEnv('NOTIFICATION_PREFERENCES_ENABLED', 'true');
  vi.stubEnv('CAMPAIGN_ENGINE_ENABLED', 'true');
  vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
  session.mockResolvedValue({ token: TOKEN });
  upstream.mockResolvedValue(Response.json({ data: { action: 'list', threads: [], nextBefore: null } }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('refused under clinic-membership sign-in, before any token leaves the process', () => {
  it.each([
    ['recording authority', () => recordingAuthorityRequest({}, TOKEN)],
    ['recording capture', () => recordingCaptureRequest({}, TOKEN)],
    ['recording drafting', () => recordingDraftingRequest({}, TOKEN)],
    ['recording transcription', () => recordingTranscriptionRequest({}, TOKEN)],
    ['recording cleanup review', () => recordingCleanupReviewRequest({}, TOKEN)],
    ['recording cleanup execution', () => recordingCleanupExecutionRequest({}, TOKEN)],
    ['Ask ALP configuration', () => getAskAlpConfiguration(`Bearer ${LONG_TOKEN}`)],
  ])('%s: refused as not available under clinic-membership sign-in', async (_label, run) => {
    await expect(run()).rejects.toMatchObject(refusedAdapter);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['care messages', () => careMessages(route('/api/live/care-messages', { action: 'list' }))],
    ['patient notification settings', () => notificationSettings(route('/api/live/patient-notification-settings',
      { action: 'read', connectionId: '44444444-4444-4444-8444-444444444444' }))],
    ['program assignments', () => programAssignments(route('/api/live/program-assignments', { action: 'programs' }))],
  ])('%s: the live route answers 503 membership_authority_not_configured', async (_label, run) => {
    const answered = await run();
    expect(answered.status).toBe(503);
    expect(await answered.json()).toEqual({ error: CLINIC_MEMBERSHIP_REFUSAL });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('calendar connection, consult and clinic records: their typed refusals, with no request', async () => {
    await expect(calendarWorkforceCall(TOKEN)({ action: 'status' } as never)).rejects.toBeInstanceOf(CalendarWorkforceError);
    await expect(consultLinkCall(TOKEN)({ action: 'list' })).rejects.toMatchObject({ status: 503, code: CLINIC_MEMBERSHIP_REFUSAL });
    await expect(clinicRecordsWorkforceCall(TOKEN)({ action: 'list' })).rejects.toMatchObject({ status: 503, code: CLINIC_MEMBERSHIP_REFUSAL });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('privacy operations, lab attestation and the synthetic boundary: refused, decided here', async () => {
    await expect(requestPrivacyOperation(TOKEN, { action: 'listRequests' } as never)).rejects.toMatchObject({ code: CLINIC_MEMBERSHIP_REFUSAL });
    vi.stubEnv('CLINICAL_LAB_ATTESTATION_ACTIVATION', 'fictional-evidence');
    expect(await labAttestationReviewUpstream({} as never, TOKEN)).toEqual({ ok: false, status: 409, code: 'lab_attestation_disabled' });
    expect(await labAttestationUpstream({} as never, TOKEN)).toEqual({ ok: false, status: 409, code: 'lab_attestation_disabled' });
    await expect(getSyntheticClinicalCorePosture('workforce', `Bearer ${TOKEN}`)).rejects.toMatchObject({ code: 'synthetic_clinical_core_unavailable' });
    await expect(issueSyntheticPatientInvitation(`Bearer ${TOKEN}`, '66666666-6666-4666-8666-666666666666'))
      .rejects.toMatchObject({ code: 'synthetic_clinical_core_unavailable' });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('the legacy default is unchanged', () => {
  beforeEach(() => { vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', ''); });

  it('reaches each caller\'s own validation or service, as before', async () => {
    // Past the refusal, each meets its own input check (nothing valid was sent), not the clinic-membership refusal.
    for (const run of [() => recordingAuthorityRequest({}, TOKEN), () => recordingDraftingRequest({}, TOKEN),
      () => recordingTranscriptionRequest({}, TOKEN), () => recordingCaptureRequest({}, TOKEN)]) {
      await expect(run()).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(requestPrivacyOperation(TOKEN, { action: 'listRequests' } as never)).rejects.toMatchObject({ code: 'request_invalid' });
    const answered = await careMessages(route('/api/live/care-messages', { action: 'list' }));
    expect(answered.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const headers = (upstream.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('x-alp-selected-organization-id');
  });
});

describe('intentionally independent', () => {
  it('the campaign API still answers under clinic-membership sign-in, and never names or reads a clinic', async () => {
    upstream.mockResolvedValue(Response.json({ data: { ok: true } }));
    await expect(campaignApiCall({ method: 'GET', path: '/campaigns/status', token: TOKEN })).resolves.toEqual({ ok: true });
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/campaigns/status`);
    expect(JSON.stringify(init.headers).toLowerCase()).not.toContain('x-alp-selected-organization-id');
    const source = readFileSync('src/server/campaign-api.ts', 'utf8');
    expect(source).not.toMatch(/clinical-core|selected-clinic|clinicalAuthorityMode|aidp_org/);
  });
});

/** Every source file that names a workforce route, and what it is. A new caller must be classified here. */
const CLASSIFIED: Record<string, 'converted' | `refused:${keyof typeof UNCONVERTED_CLINIC_FAMILIES}`
  | `gated:${keyof typeof CURRENT_MEMBERSHIP_GATED_FAMILIES}` | 'not_a_desktop_caller'> = {
  'src/adapters/aws-clinical-data.server.ts': 'converted',
  'src/adapters/telehealth.live.ts': 'converted',
  'src/adapters/telehealth-requests.live.ts': 'converted',
  'src/server/programs/program-catalog-observation.ts': 'converted',
  'src/adapters/recording-authority.server.ts': 'refused:encounter_recording',
  'src/adapters/recording-capture.server.ts': 'refused:encounter_recording',
  'src/adapters/recording-cleanup-execution.server.ts': 'refused:encounter_recording',
  'src/adapters/recording-cleanup-review.server.ts': 'refused:encounter_recording',
  'src/adapters/recording-drafting.server.ts': 'refused:encounter_recording',
  'src/adapters/recording-transcription.server.ts': 'refused:encounter_recording',
  'src/app/api/live/calendar-connection/workforce.ts': 'refused:calendar_connection',
  'src/app/api/live/care-messages/route.ts': 'gated:care_messages',
  'src/app/api/live/patient-notification-settings/route.ts': 'refused:patient_notification_settings',
  'src/app/api/live/program-assignments/route.ts': 'gated:program_assignments',
  'src/server/clinical-core/ask-alp-workforce-client.ts': 'refused:ask_alp_workforce',
  'src/server/clinical-core/privacy-operations-client.ts': 'refused:privacy_operations',
  'src/server/lab-attestation-upstream.ts': 'refused:lab_attestation',
  'src/server/consult/consultWorkforceApi.ts': 'refused:consult_workforce',
  'src/server/clinical-core/synthetic-api-client.ts': 'refused:synthetic_boundary',
  // Route declarations, AWS-side handlers, operator and acceptance tools, contracts: none is a Desktop session's caller.
  'src/contracts/telehealthRecordInventory.ts': 'not_a_desktop_caller',
  'src/server/clinic-authority-families.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/production-pilot-policy.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/aws-governed-catalog-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/aws-identity-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/aws-production-clinical-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/aws-telehealth-requests.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/aws-workforce-applications-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/export-retention-acceptance.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/lab-attestation-review.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/privacy-operations-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/production-care-connections-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/production-care-messaging-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/production-clinic-records-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/qualification-program-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/recording-acceptance.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/recording-authority-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/recording-capture-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/recording-cleanup-execution-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/recording-cleanup-review-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/recording-drafting-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/recording-transcription-api.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/security-qualification.ts': 'not_a_desktop_caller',
  'src/server/clinical-core/synthetic-acceptance.ts': 'not_a_desktop_caller',
  'src/server/fullscript/qualification-api.ts': 'not_a_desktop_caller',
  'src/server/fullscript/qualification-deployment-execution.ts': 'not_a_desktop_caller',
  'src/server/fullscript/qualification-deployment-native.ts': 'not_a_desktop_caller',
};
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.|test-support/.test(name) ? [path] : [];
  });
}

describe('the audit is exhaustive', () => {
  it('classifies every source file that names a workforce route', () => {
    const naming = sources('src').filter((path) => readFileSync(path, 'utf8').includes('/clinical-core/workforce/')).sort();
    expect(naming).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it('each refused caller checks its own family; each converted caller sends the selection', () => {
    for (const [path, decision] of Object.entries(CLASSIFIED)) {
      const source = readFileSync(path, 'utf8');
      if (decision.startsWith('refused:')) {
        expect(source, path).toMatch(new RegExp(`refusedUnderClinicMembership\\(["']${decision.slice(8)}["']\\)`));
      }
      if (decision === 'converted') expect(source, path).toMatch(/selectedClinicHeaders|x-alp-selected-organization-id/);
      // A gated caller keeps its refusal, then sends only the session's clinic and accepts only an answer that names it.
      if (decision.startsWith('gated:')) {
        expect(source, path).toMatch(new RegExp(`refusedUnderClinicMembership\\(["']${decision.slice(6)}["']\\)`));
        expect(source, path).toMatch(/currentMembershipCall\(session\.token\)/);
        expect(source, path).toMatch(/decidedInSelectedClinic\(response,clinic\.organizationId\)/);
      }
    }
    const families = new Set(Object.values(CLASSIFIED).filter((decision) => decision.startsWith('refused:')).map((decision) => decision.slice(8)));
    expect([...families].sort()).toEqual(Object.keys(UNCONVERTED_CLINIC_FAMILIES).sort());
  });
});
