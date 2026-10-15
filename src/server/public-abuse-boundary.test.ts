import { describe, expect, it } from 'vitest';
import { abuseKey, ABUSE_SURFACES, createSharedAbuseBoundary, INACTIVE_ABUSE_BOUNDARY, SHARED_ABUSE_LIMITS, sharedAbuseBoundary, type AbuseCounterStore } from './public-abuse-boundary';

// The shared abuse boundary's policy and fail-closed behaviour, against an in-memory counter. Inactive in this build.
const memory = (): AbuseCounterStore & { keys: string[] } => {
  const counts = new Map<string, number>();
  return { keys: [], async increment(key, windowStart) {
    const slot = `${key}@${windowStart}`; this.keys.push(key);
    counts.set(slot, (counts.get(slot) ?? 0) + 1); return counts.get(slot)!;
  } };
};

describe('public abuse boundary', () => {
  it('is inactive in this build: no reviewed shared counter service exists', async () => {
    expect(sharedAbuseBoundary()).toBe(INACTIVE_ABUSE_BOUNDARY);
    expect(INACTIVE_ABUSE_BOUNDARY.active).toBe(false);
    expect(await INACTIVE_ABUSE_BOUNDARY.decide('workforce_application_submit', {})).toBe('admitted');
  });

  it('has a limit for every surface, and counts only digests', async () => {
    for (const surface of ABUSE_SURFACES) expect(Object.keys(SHARED_ABUSE_LIMITS[surface].limits).length).toBeGreaterThan(0);
    const store = memory();
    const boundary = createSharedAbuseBoundary(store, () => 1_000_000);
    const email = abuseKey('email', ' Fictional.Applicant@Example.TEST ');
    expect(email).toBe(abuseKey('email', 'fictional.applicant@example.test'));
    await boundary.decide('workforce_signup_code_resend', { email, client: abuseKey('client', '198.51.100.7') });
    expect(store.keys.join(' ')).not.toMatch(/fictional|example|198\.51/);
    // A raw value where a digest belongs is refused, not counted.
    expect(await boundary.decide('workforce_signup_code_resend', { email: 'fictional.applicant@example.test' })).toBe('unavailable');
  });

  it('limits per key within a window and admits again in the next', async () => {
    let now = 5_000_000;
    const boundary = createSharedAbuseBoundary(memory(), () => now);
    const subject = abuseKey('subject', 'fictional-subject');
    const limit = SHARED_ABUSE_LIMITS.workforce_application_submit.limits.subject!;
    for (let attempt = 0; attempt < limit; attempt += 1) expect(await boundary.decide('workforce_application_submit', { subject })).toBe('admitted');
    expect(await boundary.decide('workforce_application_submit', { subject })).toBe('limited');
    expect(await boundary.decide('workforce_application_submit', { subject: abuseKey('subject', 'another-fictional-subject') })).toBe('admitted');
    now += SHARED_ABUSE_LIMITS.workforce_application_submit.windowSeconds * 1000;
    expect(await boundary.decide('workforce_application_submit', { subject })).toBe('admitted');
  });

  it('fails closed when active and the counter cannot answer', async () => {
    const boundary = createSharedAbuseBoundary({ increment: async () => { throw new Error('counter unreachable'); } });
    expect(await boundary.decide('workforce_application_status', { subject: abuseKey('subject', 'x') })).toBe('unavailable');
  });
});
