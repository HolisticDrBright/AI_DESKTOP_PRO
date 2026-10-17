import { describe, expect, it } from 'vitest';
import { engineStatus, type WorkforceResponse } from './contract';
import { createAwsCampaignSes } from './ses';
import { fictionalEngine } from './testing';

/**
 * The `status` read behind the Outreach status screen: any staff member of the practice may ask, with no marketing
 * role and no entitlement, and the answer is flags and counts only. SES production access is the account's, and
 * "unknown" when SES does not answer, never a guess. Fictional practices, people and addresses only.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', subject: 'fictional-subject-21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const STAFF = { practiceId: PRACTICE, personId: '31111111-1111-4111-8111-111111111111', subject: 'fictional-subject-31111111-1111-4111-8111-111111111111', email: 'front-desk@fictional-clinic.example' };
const status = (r: WorkforceResponse) => { if (r.action !== 'status') throw new Error(r.action); return engineStatus.parse(r); };
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };

describe('the engine status read', () => {
  it('answers a practice without the package, for staff with no marketing role: not entitled, nothing set, sandboxed', async () => {
    const e = fictionalEngine();
    const s = status(await e.staff.handle(STAFF, { action: 'status' }));
    expect(s).toMatchObject({ marketing: false, tier: null, domain: null, sesProductionAccess: 'not_granted', activeSequences: [], scheduledBroadcasts: 0, approvedTemplates: 0 });
    expect(s.readiness.canSend).toBe(false);
    expect(s.readiness.missing).toContain('The practice does not hold the marketing package.');
    // Every other action still needs the package and the role.
    await expect(e.staff.handle(STAFF, { action: 'refresh_domain' })).rejects.toMatchObject({ category: 'not_entitled' });
  });

  it('reports the domain, readiness, active sequences and approved emails as counts, and nothing personal', async () => {
    const e = fictionalEngine();
    const ask = await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
    const o = done(await ask({ action: 'install_starter', programKey: 'longevity-program' }));
    const seq = o.sequences.find(x => x.programKey === 'longevity-program')!;
    for (const step of seq.steps) {
      const t = o.templates.find(x => x.templateId === step.templateId)!;
      done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
    }
    done(await ask({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: seq.version, status: 'active' }));
    e.ses.account.production = true;

    const s = status(await e.staff.handle(STAFF, { action: 'status' }));
    expect(s).toEqual({
      action: 'status', contract: 'campaign-engine/1', marketing: true, tier: 'growth',
      domain: { verifiedForSending: true, dkim: 'success', mailFrom: 'success' },
      readiness: { canSend: true, missing: [] }, sesProductionAccess: 'granted',
      activeSequences: ['longevity-program'], scheduledBroadcasts: 0, approvedTemplates: seq.steps.length,
    });
    const text = JSON.stringify(s);
    for (const personal of ['@', 'Fictional Way', 'Fictional Clinic', 'mail.fictional-clinic.example', 'Welcome']) expect(text).not.toContain(personal);
  });

  it('says "unknown" when SES does not answer, and still answers everything else', async () => {
    const e = fictionalEngine();
    await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
    e.ses.account.production = 'silent';
    const s = status(await e.staff.handle(STAFF, { action: 'status' }));
    expect(s.sesProductionAccess).toBe('unknown');
    expect(s.marketing).toBe(true);
  });

  it('is one practice\'s answer: another practice\'s staff see their own, empty, practice', async () => {
    const e = fictionalEngine();
    await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
    const s = status(await e.staff.handle({ practiceId: OTHER, personId: '41111111-1111-4111-8111-111111111111', subject: 'fictional-subject-41111111-1111-4111-8111-111111111111', email: null }, { action: 'status' }));
    expect(s).toMatchObject({ marketing: false, domain: null, activeSequences: [], approvedTemplates: 0 });
  });

  it('is refused when the engine is switched off', async () => {
    const e = fictionalEngine({ config: { enabled: false } });
    await expect(e.staff.handle(STAFF, { action: 'status' })).rejects.toMatchObject({ category: 'disabled' });
  });

  it('reads production access from GetAccount at the SDK boundary', async () => {
    const calls: string[] = [];
    const client = (reply: unknown) => ({ send: async (command: { constructor: { name: string } }) => { calls.push(command.constructor.name); if (reply instanceof Error) throw reply; return reply; } });
    const ses = (reply: unknown) => createAwsCampaignSes({ client: client(reply) as never, region: 'us-east-2', accountId: '111122223333' });
    expect(await ses({ ProductionAccessEnabled: true, SendQuota: { MaxSendRate: 14 } }).productionAccess()).toBe(true);
    expect(await ses({ ProductionAccessEnabled: false }).productionAccess()).toBe(false);
    expect(await ses({}).productionAccess()).toBe(false);
    await expect(ses(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })).productionAccess()).rejects.toThrow();
    expect(calls).toEqual(['GetAccountCommand', 'GetAccountCommand', 'GetAccountCommand', 'GetAccountCommand']);
  });
});
