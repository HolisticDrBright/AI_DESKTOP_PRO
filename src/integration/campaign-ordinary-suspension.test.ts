import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorkforceRequest, WorkforceResponse } from '@/campaigns/contract';
import { FORM_MIN_MS } from '@/campaigns/public';
import { fictionalEngine, tokenFrom } from '@/campaigns/testing';
import { createWorkforcePreTokenCandidate } from '@/server/clinical-core/aws-workforce-token-binding';

/**
 * Campaign staff access across an ORDINARY clinic suspension, read and tested from outside the campaign engine (its
 * source is not changed here). Two owner decisions apply to practitioner sessions: an ordinary suspension leaves an
 * already-valid session read-only until its token expires, with no refresh extension; a compromised login is refused
 * at once. Only the second reaches the campaign engine today:
 *
 *   - COVERAGE: the revocation signal refuses a revoked login's every token (docs/campaign-staff-revocation-2026-10-17.md).
 *   - HELD (owner decision, docs/clinic-continuity-release-map-2026-10-17.md §3, R4): the staff route authorizes from
 *     the token's `custom:organization_id`, `exp` and the engine's own role grants. It reads neither the clinic's status
 *     nor the token's `iat`, so it cannot tell a session from before a suspension from a refresh after it, and it
 *     admits writes for both. Whether an ordinary clinical suspension should reach marketing at all is not decided.
 *   - The one source lever for refreshed tokens is the BLOCKED pre-token trigger: on a refresh while the clinic is not
 *     active it mints no clinic claim, and the staff route then refuses that token. It is not deployed.
 *
 * Fictional practices, people, subjects and addresses only.
 */
const PRACTICE = '5a1e0000-0000-4000-8000-000000000001';
const ADMIN = { practiceId: PRACTICE, personId: '5a1e0000-0000-4000-8000-000000000002', subject: '5a1e0000-0000-4000-8000-000000000003',
  email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };
const BROADCAST_SUBJECT = 'An update about the Longevity Program';
const now = () => Math.floor(Date.now() / 1000);
/** The verified ID token's claims as the authorizer passes them. */
const claims = (iat: number, extra: Record<string, unknown> = {}) => ({ authorizer: { jwt: { claims: {
  sub: ADMIN.subject, 'custom:organization_id': ADMIN.practiceId, 'custom:person_id': ADMIN.personId, email: ADMIN.email,
  iat, exp: iat + 3600, ...extra } } } });

async function practice() {
  const e = fictionalEngine();
  const ask = await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-suspended-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
  const page = await e.publicSide.joinPage('fictional-suspended-clinic', 'longevity-program');
  e.advance(FORM_MIN_MS + 10);
  await e.publicSide.join({ practice: 'fictional-suspended-clinic', program: 'longevity-program', email: 'avery@fictional.example', consent: 'yes', formToken: page!.formToken });
  await e.publicSide.confirm(tokenFrom(e.ses.outbox.at(-1)!.text, '/join/confirm'));
  done(await ask({ action: 'install_starter', programKey: 'longevity-program' }));
  const o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'Fictional update',
    subject: BROADCAST_SUBJECT, blocks: [{ type: 'paragraph', text: 'Hello {{first_name|there}}, the program now offers evening consultations.' }, { type: 'button', label: 'Read about the program' }] } }));
  const template = o.templates.find(x => x.name === 'Fictional update')!;
  done(await ask({ action: 'approve_template', templateId: template.templateId, version: template.version }));
  const broadcast = done(await ask({ action: 'save_broadcast', broadcastId: null, programKey: 'longevity-program', templateId: template.templateId })).broadcasts
    .find(x => x.templateId === template.templateId)!;
  done(await ask({ action: 'test_send', templateId: template.templateId, broadcastId: broadcast.broadcastId }));
  const staff = async (requestContext: ReturnType<typeof claims>, body: WorkforceRequest) => {
    const reply = await e.http({ routeKey: 'POST /campaigns/workforce', body: JSON.stringify(body), requestContext });
    return { status: reply.statusCode, body: JSON.parse(reply.body) as { error?: string; detail?: string } };
  };
  const broadcastMail = () => e.ses.outbox.filter(m => m.subject === BROADCAST_SUBJECT);
  return { e, staff, template, broadcast, broadcastMail };
}
const writes = (p: Awaited<ReturnType<typeof practice>>, tag: string): Array<[string, WorkforceRequest]> => [
  ['export', { action: 'contacts', programKey: 'longevity-program' }],
  ['edit', { action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: `Edited ${tag}`,
    subject: 'Edited', blocks: [{ type: 'paragraph', text: 'Fictional text.' }] } }],
  ['approve', { action: 'approve_template', templateId: p.template.templateId, version: p.template.version }],
  ['grant', { action: 'grant_role', personId: tag === 'refreshed after it' ? '5a1e0000-0000-4000-8000-000000000005' : '5a1e0000-0000-4000-8000-000000000004',
    role: 'marketing_admin', name: `Fictional colleague ${tag}` }],
];

describe('campaign staff across an ordinary clinic suspension', () => {
  it('HELD: the staff route reads neither clinic status nor token iat, so a pre-suspension token and a post-suspension refresh both write', async () => {
    const p = await practice();
    const suspendedAt = now() - 300; // the clinic was suspended five minutes ago; the engine cannot be told
    for (const [label, iat] of [['issued before the suspension', suspendedAt - 600], ['refreshed after it', now()]] as const) {
      for (const [operation, request] of writes(p, label)) {
        expect({ label, operation, status: (await p.staff(claims(iat), request)).status }).toEqual({ label, operation, status: 200 });
      }
    }
    // The route's own inputs, read from source: the token's subject, clinic, person, exp and email. No iat.
    const route = readFileSync('src/campaigns/http.ts', 'utf8');
    expect(route).toMatch(/claims\['custom:organization_id'\]/);
    expect(route).not.toMatch(/\biat\b/);
  });

  it('HELD: a broadcast scheduled before the suspension is sent after it', async () => {
    const p = await practice();
    expect((await p.staff(claims(now() - 900), { action: 'schedule_broadcast', broadcastId: p.broadcast.broadcastId, sendAt: p.e.now().toISOString() })).status).toBe(200);
    await p.e.pass();
    expect(p.broadcastMail()).toHaveLength(1);
  });

  it('COVERAGE: a compromised login is refused at once, whatever its iat, and its queued broadcast is held', async () => {
    const p = await practice();
    expect((await p.staff(claims(now() - 900), { action: 'schedule_broadcast', broadcastId: p.broadcast.broadcastId, sendAt: p.e.now().toISOString() })).status).toBe(200);
    p.e.revocations.revoke(ADMIN.subject);
    for (const iat of [now() - 900, now()]) expect(await p.staff(claims(iat), { action: 'overview' })).toEqual({ status: 403, body: { error: 'forbidden', detail: 'identity_refused' } });
    await p.e.pass();
    expect(p.broadcastMail()).toHaveLength(0);
  });

  it('the BLOCKED pre-token trigger is the source lever for refreshes: no clinic claim on a refresh in a suspended clinic, and the route refuses that token', async () => {
    const p = await practice();
    const trigger = createWorkforcePreTokenCandidate({
      configuration: { userPoolId: 'us-east-2_ueGlFRbNB', clientId: '4s7jgr4o8sqdq7cvo9gmq96e2h', activation: 'qualification', phiAllowed: false,
        activationEvidenceSha256: 'f'.repeat(64), qualificationAccountId: '588966314750', qualificationIdentitySubjects: [ADMIN.subject] },
      lookup: async subject => ({ subject, identityPool: 'workforce', personId: ADMIN.personId, organizationId: ADMIN.practiceId, identityStatus: 'active',
        personStatus: 'active', organizationStatus: 'suspended', membershipStatus: 'active', activeMembershipCount: 1, productionBound: true }),
    });
    const refreshed = await trigger({ version: '1', triggerSource: 'TokenGeneration_RefreshTokens', region: 'us-east-2', userPoolId: 'us-east-2_ueGlFRbNB',
      callerContext: { clientId: '4s7jgr4o8sqdq7cvo9gmq96e2h' }, request: { userAttributes: { sub: ADMIN.subject, email_verified: 'true', 'custom:synthetic_attested': 'true' } } });
    const suppressed = (refreshed.response as { claimsOverrideDetails: { claimsToSuppress?: string[] } }).claimsOverrideDetails.claimsToSuppress;
    expect(suppressed).toEqual(['custom:person_id', 'custom:organization_id', 'custom:production_bound']);
    // The refreshed token as Cognito would then issue it: no clinic claim. The route refuses it before any operation.
    const withoutClinic = claims(now());
    for (const claim of suppressed!) delete (withoutClinic.authorizer.jwt.claims as Record<string, unknown>)[claim];
    expect(await p.staff(withoutClinic, { action: 'overview' })).toEqual({ status: 403, body: { error: 'forbidden', detail: 'identity_refused' } });
    // The token minted before the suspension still carries the claim: it keeps every write until it expires (HELD above).
    expect((await p.staff(claims(now() - 900), writes(p, 'after the refresh')[1]![1])).status).toBe(200);
  });
});
