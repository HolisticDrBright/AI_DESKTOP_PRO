import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ClinicBootstrapState } from '@/contracts/workforceClinicBootstrap';
import type { JourneyState } from './applicant-journey';
import { canCreateClinic, canProposeClinic, createOutcome, hasCreatedClinic, newClinicState, type BootstrapRead } from './clinic-bootstrap-journey';

// The "Create a new clinic" door: each state from the answer that supports it, and nothing from an answer that does
// not. Fictional identifiers only.
const clinic = (extra: Partial<ClinicBootstrapState> = {}): ClinicBootstrapState => ({ requestId: randomUUID(), organizationId: randomUUID(),
  status: 'active', suspensionReason: null, clinicalAccess: 'available', createdAt: '2026-10-16T12:00:00Z', ...extra });
const answered = (value: ClinicBootstrapState | null, clinicSignIn: 'current_membership' | 'legacy_claims' = 'current_membership', inSession: boolean | null = true): BootstrapRead =>
  ({ kind: 'answered', clinic: value, clinicSignIn, inSession });
const application = (state: JourneyState['state']) => ({ state, history: [] }) as unknown as JourneyState;

describe('new-clinic door', () => {
  it('a held door is closed, and no answer is never "no clinic"', () => {
    expect(newClinicState({ kind: 'not_released' }).state).toBe('closed');
    for (const read of [{ kind: 'failed' }, { kind: 'unavailable' }, { kind: 'signed_out' }, { kind: 'refused', code: 'workforce_applicant_mfa_required' }] as BootstrapRead[]) {
      expect(newClinicState(read).state).toBe('unknown');
    }
    expect(newClinicState(answered(null)).state).toBe('none');
  });

  it('a created clinic is ready only when the database, this Desktop and this session all say so', () => {
    expect(newClinicState(answered(clinic()))).toMatchObject({ state: 'ready' });
    expect(newClinicState(answered(clinic(), 'legacy_claims'))).toMatchObject({ state: 'created_not_authorized', reason: 'desktop_not_on_current_membership' });
    expect(newClinicState(answered(clinic(), 'current_membership', false))).toMatchObject({ state: 'created_not_authorized', reason: 'clinic_not_in_session' });
    // Discovery that could not be read is not "in session".
    expect(newClinicState(answered(clinic(), 'current_membership', null))).toMatchObject({ state: 'created_not_authorized', reason: 'clinic_not_in_session' });
    expect(newClinicState(answered(clinic({ clinicalAccess: 'not_available' })))).toMatchObject({ state: 'created_not_authorized', reason: 'membership_not_current' });
  });

  it('a suspended clinic carries its recorded reason, Unknown when none was recorded, and is never ready', () => {
    expect(newClinicState(answered(clinic({ status: 'suspended', suspensionReason: 'security_concern', clinicalAccess: 'not_available' }))))
      .toMatchObject({ state: 'suspended', reason: 'security_concern' });
    // Even an answer that still claims access is not access once suspended.
    expect(newClinicState(answered(clinic({ status: 'suspended', suspensionReason: null, clinicalAccess: 'available' }))))
      .toMatchObject({ state: 'suspended', reason: null });
  });

  it('offers the create form only when the service answered "none" and the account itself is fine', () => {
    const none = newClinicState(answered(null));
    for (const state of ['not_submitted', 'join_pending', 'rejected', 'withdrawn', 'approved_not_authorized', 'clinical_access_available'] as const) {
      expect(canCreateClinic(none, application(state))).toBe(true);
    }
    // The account's own problems, a pending proposal (refused by the service too) and no answer all hold the form.
    for (const state of ['signed_out', 'unavailable', 'failed', 'rate_limited', 'account_refused', 'account_unconfirmed', 'mfa_incomplete', 'proposal_pending'] as const) {
      expect(canCreateClinic(none, application(state))).toBe(false);
    }
    for (const door of [newClinicState({ kind: 'not_released' }), newClinicState({ kind: 'failed' }), newClinicState(answered(clinic()))]) {
      expect(canCreateClinic(door, application('not_submitted'))).toBe(false);
    }
  });

  it('keeps the held proposal for a new clinic only where the create door cannot serve this account', () => {
    expect(canProposeClinic(newClinicState({ kind: 'not_released' }))).toBe(true);
    expect(canProposeClinic(newClinicState(answered(clinic())))).toBe(true);
    expect(canProposeClinic(newClinicState(answered(clinic({ status: 'suspended', suspensionReason: 'operator_request', clinicalAccess: 'not_available' }))))).toBe(true);
    expect(canProposeClinic(newClinicState(answered(null)))).toBe(false);
    expect(canProposeClinic(newClinicState({ kind: 'failed' }))).toBe(false);
    expect(hasCreatedClinic(newClinicState(answered(null)))).toBe(false);
  });
});

describe('one create attempt', () => {
  it('keeps the request id only where the clinic may exist unconfirmed, or nothing was processed', () => {
    expect(createOutcome('no_answer')).toEqual({ kind: 'lost', keep: true });
    expect(createOutcome({ status: 503, error: 'workforce_application_unavailable' })).toEqual({ kind: 'lost', keep: true });
    expect(createOutcome({ status: 502 })).toEqual({ kind: 'lost', keep: true });
    expect(createOutcome({ status: 429, error: 'workforce_application_rate_limited' })).toEqual({ kind: 'rate_limited', keep: true });
  });

  it('ends the attempt on a definite answer and on every refusal that names this account\'s state', () => {
    expect(createOutcome({ status: 201, duplicate: false })).toEqual({ kind: 'created', keep: false });
    expect(createOutcome({ status: 200, duplicate: true })).toEqual({ kind: 'already_created', keep: false });
    const named: Array<[number, string, string]> = [
      [503, 'workforce_clinic_bootstrap_not_released', 'closed'], [409, 'workforce_clinic_bootstrap_exists', 'exists'],
      [409, 'workforce_clinic_bootstrap_conflict', 'conflict'], [409, 'workforce_application_already_pending', 'proposal_pending'],
      [403, 'workforce_applicant_mfa_required', 'mfa'], [403, 'workforce_applicant_email_unverified', 'email'],
      [403, 'workforce_applicant_refused', 'refused'], [400, 'request_invalid', 'invalid'], [401, 'reauth_required', 'signed_out'],
      [403, 'identity_refused', 'cross_site'], [503, 'application_service_not_configured', 'not_configured'],
    ];
    for (const [status, error, kind] of named) expect(createOutcome({ status, error })).toEqual({ kind, keep: false });
  });
});
