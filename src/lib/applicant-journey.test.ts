import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApplicationEntry } from '@/contracts/workforceApplication';
import { canSubmit, journeyState, type ApplicationAnswer } from './applicant-journey';

// Every applicant state from the answer that supports it, and nothing from an answer that does not. Fictional ids only.
const clinic = randomUUID();
let clock = 0;
const entry = (status: ApplicationEntry['status'], extra: Partial<ApplicationEntry> = {}): ApplicationEntry => ({
  id: randomUUID(), kind: 'join', status, createdAt: `2026-10-15T12:00:${String(clock++).padStart(2, '0')}Z`, organizationId: clinic,
  decisionReason: null, clinicalAccess: status === 'approved' ? 'unknown' : null, ...extra,
});
const answered = (entries: ApplicationEntry[], clinicSignIn: 'current_membership' | 'legacy_claims' = 'current_membership', clinicIds: string[] | null = [clinic]): ApplicationAnswer =>
  ({ kind: 'answered', entries, clinicSignIn, clinicIds });

describe('applicant journey', () => {
  it('derives each account state only from the service\'s own refusal', () => {
    expect(journeyState({ kind: 'refused', code: 'workforce_applicant_mfa_required' }).state).toBe('mfa_incomplete');
    expect(journeyState({ kind: 'refused', code: 'workforce_applicant_email_unverified' }).state).toBe('account_unconfirmed');
    expect(journeyState({ kind: 'refused', code: 'workforce_applicant_refused' }).state).toBe('account_refused');
    expect(journeyState({ kind: 'refused', code: 'workforce_application_rate_limited' }).state).toBe('rate_limited');
    expect(journeyState({ kind: 'refused', code: 'workforce_application_not_released' }).state).toBe('unavailable');
    // An unknown refusal is not invented into a state.
    expect(journeyState({ kind: 'refused', code: 'something_new' }).state).toBe('failed');
  });

  it('never reads "no application" from a missing or failed service', () => {
    expect(journeyState({ kind: 'unavailable' }).state).toBe('unavailable');
    expect(journeyState({ kind: 'failed' }).state).toBe('failed');
    expect(journeyState({ kind: 'signed_out' }).state).toBe('signed_out');
    expect(journeyState(answered([])).state).toBe('not_submitted');
  });

  it('names pending joins and pending proposals apart, ahead of any history', () => {
    const old = entry('rejected', { decisionReason: 'not_known_to_clinic' });
    expect(journeyState(answered([old, entry('pending')]))).toMatchObject({ state: 'join_pending' });
    expect(journeyState(answered([old, entry('pending', { kind: 'create_clinic', organizationId: null })]))).toMatchObject({ state: 'proposal_pending' });
  });

  it('rejected and withdrawn are the latest request\'s own outcome', () => {
    expect(journeyState(answered([entry('withdrawn'), entry('rejected', { decisionReason: 'clinic_not_accepting' })]))).toMatchObject({ state: 'rejected' });
    expect(journeyState(answered([entry('rejected'), entry('withdrawn')]))).toMatchObject({ state: 'withdrawn' });
  });

  it('approval is clinical access only when the database, this Desktop and this session all say so', () => {
    const usable = entry('approved', { clinicalAccess: 'available' });
    expect(journeyState(answered([usable]))).toMatchObject({ state: 'clinical_access_available' });
    expect(journeyState(answered([usable], 'legacy_claims'))).toMatchObject({ state: 'approved_not_authorized', reason: 'desktop_not_on_current_membership' });
    expect(journeyState(answered([usable], 'current_membership', []))).toMatchObject({ state: 'approved_not_authorized', reason: 'clinic_not_in_session' });
    expect(journeyState(answered([usable], 'current_membership', null))).toMatchObject({ state: 'approved_not_authorized', reason: 'clinic_not_in_session' });
    expect(journeyState(answered([entry('approved', { clinicalAccess: 'held_for_clinic_activation', kind: 'create_clinic' })])))
      .toMatchObject({ state: 'approved_not_authorized', reason: 'clinic_activation_held' });
    expect(journeyState(answered([entry('approved', { clinicalAccess: 'not_available' })]))).toMatchObject({ state: 'approved_not_authorized', reason: 'membership_not_current' });
    // A service that does not report access (the onboarding parent) never reads as access.
    expect(journeyState(answered([entry('approved', { clinicalAccess: 'unknown' })]))).toMatchObject({ state: 'approved_not_authorized', reason: 'access_unknown' });
  });

  it('a revoked approval is not hidden behind a later withdrawal, and an active one in another clinic still counts', () => {
    const revoked = entry('approved', { clinicalAccess: 'not_available' });
    expect(journeyState(answered([revoked, entry('withdrawn')]))).toMatchObject({ state: 'approved_not_authorized', reason: 'membership_not_current' });
    const other = randomUUID();
    const active = entry('approved', { clinicalAccess: 'available', organizationId: other });
    expect(journeyState(answered([revoked, active], 'current_membership', [other]))).toMatchObject({ state: 'clinical_access_available', request: { organizationId: other } });
  });

  it('a new request may start only when none is pending and the account is not the problem', () => {
    const allowed = [answered([]), answered([entry('rejected')]), answered([entry('withdrawn')]), answered([entry('approved', { clinicalAccess: 'available' })])];
    for (const answer of allowed) expect(canSubmit(journeyState(answer))).toBe(true);
    const refused: ApplicationAnswer[] = [answered([entry('pending')]), { kind: 'refused', code: 'workforce_applicant_mfa_required' },
      { kind: 'refused', code: 'workforce_applicant_email_unverified' }, { kind: 'unavailable' }, { kind: 'failed' }, { kind: 'signed_out' }];
    for (const answer of refused) expect(canSubmit(journeyState(answer))).toBe(false);
  });
});
