import { CAMPAIGN_ENGINE_CONTRACT, CAMPAIGN_PROGRAMS, emailTemplate, workforceRequest, type Broadcast, type CampaignOverview, type CampaignProgram, type EmailSequence, type EmailTemplate,
  type PracticeSettings, type RoleGrant, type WorkforceResponse } from './contract';
import { renderEmail, templateProblems } from './content';
import { CampaignError, listCounts, loadPractice, roleOf, type ContactBody, type EngineDeps, type PracticeContext } from './practice-context';
import { tenantNameFor } from './ses';
import { STARTER_SEQUENCES, starterTemplate, starterWaits } from './starter-content';
import { seal } from './tokens';

/**
 * The Campaigns screen's API, for one practice's staff. The practice and the person come from the verified
 * workforce token (`identity`), never from the request.
 *
 * - **Without the `marketing` entitlement**, `overview` says so and every other action is refused: nothing can be
 *   edited or sent.
 * - **Roles are the campaign engine's own** (`marketing`, `marketing_admin`), granted per person; no clinical role or
 *   membership is read. Counts are visible to the practice's staff; addresses, editing and approval need the
 *   marketing role; granting roles needs `marketing_admin`. The first `marketing_admin` is granted by the operator
 *   together with the entitlement.
 * - **Approval** is by a named staff member, for an exact template version, and is blocked by the content check, by a
 *   missing sender name or mailing address, and (for a program the practice marks so) by a missing attorney sign-off
 *   for that version. Any edit makes a new version, back in draft.
 */
export type WorkforceIdentity = { practiceId: string; personId: string; email: string | null };

export function createWorkforceCampaigns(deps: EngineDeps) {
  const now = () => deps.now?.() ?? new Date();
  const newId = () => deps.newId?.() ?? crypto.randomUUID();

  async function overview(ctx: PracticeContext, role: RoleGrant | null): Promise<CampaignOverview> {
    const [templates, sequences, broadcasts, lists, results, contacts] = await Promise.all([
      ctx.store.query<EmailTemplate>('template', { limit: 200 }), Promise.all(CAMPAIGN_PROGRAMS.map(p => sequenceOf(ctx, p))),
      ctx.store.query<Broadcast>('broadcast', { limit: 200 }), listCounts(ctx.store), ctx.store.query<Record<string, number>>('result', { limit: 200 }),
      ctx.store.get<{ confirmed?: number }>('counter', 'contacts'),
    ]);
    const tracked = ctx.settings.trackOpensAndClicks;
    return {
      contract: CAMPAIGN_ENGINE_CONTRACT,
      entitlement: { marketing: !!ctx.entitlement?.marketing, tier: ctx.entitlement?.tier ?? null, contactAllowance: ctx.allowance?.contacts ?? null, confirmedContacts: Math.max(0, contacts?.body.confirmed ?? 0) },
      role: role?.role ?? 'none', settings: ctx.settings, domain: ctx.domain, readiness: ctx.readiness, lists,
      templates: templates.items.map(t => t.body), sequences: sequences.map(s => s.body), broadcasts: broadcasts.items.map(b => b.body),
      results: results.items.map(r => ({ templateId: r.id, sent: r.body.sent ?? 0, delivered: r.body.delivered ?? 0, bounced: r.body.bounced ?? 0, complained: r.body.complained ?? 0,
        unsubscribed: r.body.unsubscribed ?? 0, opened: tracked ? r.body.opened ?? 0 : null, clicked: tracked ? r.body.clicked ?? 0 : null })),
    };
  }
  async function sequenceOf(ctx: PracticeContext, program: CampaignProgram): Promise<{ version: number; body: EmailSequence }> {
    const item = await ctx.store.get<EmailSequence>('sequence', program);
    return item ?? { version: 0, body: { programKey: program, version: 0, status: 'draft', steps: [], updatedAt: null } };
  }
  async function template(ctx: PracticeContext, templateId: string): Promise<{ version: number; body: EmailTemplate }> {
    const item = await ctx.store.get<EmailTemplate>('template', templateId);
    if (!item) throw new CampaignError('not_found', 'template');
    return item;
  }
  const isApproved = (t: EmailTemplate) => t.status === 'approved' && t.approval?.version === t.version;
  const ok = (r: 'ok' | 'conflict') => { if (r === 'conflict') throw new CampaignError('conflict'); };

  return {
    async handle(identity: WorkforceIdentity, raw: unknown): Promise<WorkforceResponse> {
      if (!deps.config.enabled) throw new CampaignError('disabled');
      const parsed = workforceRequest.safeParse(raw);
      if (!parsed.success) throw new CampaignError('invalid', 'request_invalid');
      const request = parsed.data;
      const ctx = await loadPractice(deps, identity.practiceId);
      const role = await roleOf(ctx.store, identity.personId);
      if (request.action === 'overview') return { action: 'overview', ...await overview(ctx, role) };
      if (!ctx.entitlement?.marketing) throw new CampaignError('not_entitled');
      if (!role) throw new CampaignError('forbidden', 'marketing_role_required');
      const done = async (): Promise<WorkforceResponse> => ({ action: 'done', refreshed: await overview(await loadPractice(deps, identity.practiceId), await roleOf(ctx.store, identity.personId)) });
      const at = now().toISOString();

      switch (request.action) {
        case 'contacts': {
          const page = await ctx.store.query<ContactBody>('contact', { prefix: `${request.programKey}:`, after: request.after ?? null, limit: 100 });
          return { action: 'contacts', programKey: request.programKey, after: page.after,
            contacts: page.items.filter(c => c.body.state !== 'pending').map(c => ({ email: c.body.email, firstName: c.body.firstName, state: c.body.state, since: c.body.stateAt })) };
        }
        case 'update_settings': {
          const next: PracticeSettings = { ...ctx.settings, joinSlug: request.joinSlug, senderName: request.senderName, mailingAddress: request.mailingAddress,
            timeZone: request.timeZone, trackOpensAndClicks: request.trackOpensAndClicks, version: ctx.settings.version + 1 };
          if (request.expectedVersion !== ctx.settings.version) throw new CampaignError('conflict');
          if (request.joinSlug && request.joinSlug !== ctx.settings.joinSlug) {
            if (await deps.store.global.put('slug', request.joinSlug, { practiceId: ctx.store.practiceId }, { expected: null }) === 'conflict') throw new CampaignError('conflict', 'slug_taken');
          }
          if (await ctx.store.put('settings', 'current', next, { expected: ctx.settingsVersion || null }) === 'conflict') {
            if (request.joinSlug && request.joinSlug !== ctx.settings.joinSlug) await releaseSlug(request.joinSlug, ctx.store.practiceId);
            throw new CampaignError('conflict');
          }
          if (ctx.settings.joinSlug && ctx.settings.joinSlug !== request.joinSlug) await releaseSlug(ctx.settings.joinSlug, ctx.store.practiceId);
          return done();
        }
        case 'register_domain': {
          if (role.role !== 'marketing_admin') throw new CampaignError('forbidden', 'marketing_admin_required');
          const status = await deps.ses.registerDomain({ domain: request.domain, tenant: tenantNameFor(ctx.store.practiceId), configurationSets: [deps.config.configurationSet, deps.config.trackedConfigurationSet] });
          ok(await ctx.store.put('settings', 'current', { ...ctx.settings, sendingDomain: request.domain, version: ctx.settings.version + 1 }, { expected: ctx.settingsVersion || null }));
          const existing = await ctx.store.get('domain', 'current');
          ok(await ctx.store.put('domain', 'current', status, { expected: existing?.version ?? null }));
          return done();
        }
        case 'refresh_domain': {
          if (!ctx.settings.sendingDomain) throw new CampaignError('not_ready', 'no_sending_domain');
          const status = await deps.ses.domainStatus(ctx.settings.sendingDomain);
          const existing = await ctx.store.get('domain', 'current');
          ok(await ctx.store.put('domain', 'current', status, { expected: existing?.version ?? null }));
          return done();
        }
        case 'save_template': {
          const current = request.templateId ? await template(ctx, request.templateId) : null;
          if ((current?.body.version ?? 0) !== request.expectedVersion) throw new CampaignError('conflict');
          const body: EmailTemplate = emailTemplate.parse({ ...request.draft, templateId: current?.body.templateId ?? newId(), version: (current?.body.version ?? 0) + 1,
            status: 'draft', updatedAt: at, attorneySignoff: null, approval: null });
          if (current && current.body.programKey !== body.programKey) throw new CampaignError('invalid', 'program_fixed');
          ok(await ctx.store.put('template', body.templateId, body, { expected: current?.version ?? null }));
          return done();
        }
        case 'check_template': {
          const t = await template(ctx, request.templateId);
          return { action: 'check_template', templateId: request.templateId, problems: templateProblems(t.body, ctx.settings) };
        }
        case 'record_attorney_signoff': {
          const t = await template(ctx, request.templateId);
          if (t.body.version !== request.version) throw new CampaignError('conflict');
          ok(await ctx.store.put('template', t.body.templateId, { ...t.body, attorneySignoff: { version: request.version, name: request.attorneyName, at } }, { expected: t.version }));
          return done();
        }
        case 'approve_template': {
          const t = await template(ctx, request.templateId);
          if (t.body.version !== request.version) throw new CampaignError('conflict');
          const problems = templateProblems(t.body, ctx.settings);
          if (problems.length) throw new CampaignError('not_ready', problems[0]);
          const needsAttorney = ctx.settings.attorneySignoffPrograms.includes(t.body.programKey);
          if (needsAttorney && t.body.attorneySignoff?.version !== t.body.version) throw new CampaignError('not_ready', 'attorney_signoff_required');
          ok(await ctx.store.put('template', t.body.templateId, { ...t.body, status: 'approved',
            approval: { version: t.body.version, at, by: { personId: identity.personId, name: role.name }, attorney: needsAttorney ? { name: t.body.attorneySignoff!.name, at: t.body.attorneySignoff!.at } : null } }, { expected: t.version }));
          return done();
        }
        case 'save_sequence': {
          const current = await sequenceOf(ctx, request.programKey);
          if (current.body.version !== request.expectedVersion) throw new CampaignError('conflict');
          for (const step of request.steps) {
            const t = await template(ctx, step.templateId);
            if (t.body.programKey !== request.programKey || t.body.kind !== 'sequence') throw new CampaignError('invalid', 'step_template_mismatch');
          }
          // A step keeps its id when it is kept, so people past it are never sent it again; a new step gets a new id.
          const known = new Set(current.body.steps.map(s => s.stepId));
          const steps = request.steps.map(s => ({ stepId: s.stepId && known.has(s.stepId) ? s.stepId : newId(), templateId: s.templateId, waitDays: s.waitDays }));
          if (new Set(steps.map(s => s.stepId)).size !== steps.length) throw new CampaignError('invalid', 'duplicate_step');
          ok(await ctx.store.put('sequence', request.programKey, { ...current.body, version: current.body.version + 1, steps, updatedAt: at }, { expected: current.version || null }));
          return done();
        }
        case 'set_sequence_status': {
          const current = await sequenceOf(ctx, request.programKey);
          if (current.body.version !== request.expectedVersion) throw new CampaignError('conflict');
          if (request.status === 'active') {
            if (!ctx.readiness.canSend) throw new CampaignError('not_ready', ctx.readiness.missing[0]);
            if (!current.body.steps.length) throw new CampaignError('not_ready', 'no_steps');
            for (const step of current.body.steps) if (!isApproved((await template(ctx, step.templateId)).body)) throw new CampaignError('not_ready', 'every_step_must_be_approved');
          }
          ok(await ctx.store.put('sequence', request.programKey, { ...current.body, status: request.status, version: current.body.version + 1, updatedAt: at }, { expected: current.version || null }));
          return done();
        }
        case 'save_broadcast': {
          const t = await template(ctx, request.templateId);
          if (t.body.programKey !== request.programKey || t.body.kind !== 'broadcast') throw new CampaignError('invalid', 'broadcast_template_mismatch');
          const current = request.broadcastId ? await ctx.store.get<Broadcast>('broadcast', request.broadcastId) : null;
          if (request.broadcastId && !current) throw new CampaignError('not_found', 'broadcast');
          if (current && current.body.status !== 'draft') throw new CampaignError('conflict', 'broadcast_not_draft');
          const body: Broadcast = { broadcastId: current?.body.broadcastId ?? newId(), programKey: request.programKey, templateId: request.templateId,
            status: 'draft', sendAt: null, testSent: current?.body.templateId === request.templateId ? current.body.testSent : null, createdAt: current?.body.createdAt ?? at };
          ok(await ctx.store.put('broadcast', body.broadcastId, body, { expected: current?.version ?? null }));
          return done();
        }
        case 'test_send': {
          if (!ctx.readiness.canSend) throw new CampaignError('not_ready', ctx.readiness.missing[0]);
          if (!identity.email) throw new CampaignError('not_ready', 'no_staff_email');
          const t = await template(ctx, request.templateId);
          const unsubscribe = `${new URL(deps.config.siteOrigin).origin}/join/unsubscribe?t=test`;
          const rendered = renderEmail(t.body, { settings: ctx.settings, siteOrigin: deps.config.siteOrigin, unsubscribeUrl: unsubscribe, oneClickUrl: unsubscribe, firstName: null });
          const reply = await deps.ses.send({ from: `${ctx.settings.senderName} <${deps.config.fromLocalPart}@${ctx.settings.sendingDomain}>`, to: identity.email,
            subject: `[Test] ${rendered.subject}`, html: rendered.html, text: rendered.text, headers: [], configurationSet: deps.config.configurationSet,
            tenant: tenantNameFor(ctx.store.practiceId), tags: [{ name: 'practice', value: ctx.store.practiceId }, { name: 'kind', value: 'test' }] });
          if (reply.outcome !== 'accepted') throw new CampaignError('unavailable', 'test_send_failed');
          if (request.broadcastId) {
            const b = await ctx.store.get<Broadcast>('broadcast', request.broadcastId);
            if (!b || b.body.templateId !== t.body.templateId) throw new CampaignError('not_found', 'broadcast');
            ok(await ctx.store.put('broadcast', b.body.broadcastId, { ...b.body, testSent: { at, templateVersion: t.body.version } }, { expected: b.version }));
          }
          return done();
        }
        case 'schedule_broadcast': {
          const b = await ctx.store.get<Broadcast>('broadcast', request.broadcastId);
          if (!b) throw new CampaignError('not_found', 'broadcast');
          if (b.body.status !== 'draft') throw new CampaignError('conflict', 'broadcast_not_draft');
          if (!ctx.readiness.canSend) throw new CampaignError('not_ready', ctx.readiness.missing[0]);
          const t = (await template(ctx, b.body.templateId)).body;
          if (!isApproved(t)) throw new CampaignError('not_ready', 'template_not_approved');
          if (b.body.testSent?.templateVersion !== t.version) throw new CampaignError('not_ready', 'test_send_required');
          if (Date.parse(request.sendAt) < now().getTime() - 60_000) throw new CampaignError('invalid', 'send_time_past');
          ok(await ctx.store.put('broadcast', b.body.broadcastId, { ...b.body, status: 'scheduled', sendAt: new Date(request.sendAt).toISOString() }, { expected: b.version }));
          return done();
        }
        case 'cancel_broadcast': {
          const b = await ctx.store.get<Broadcast>('broadcast', request.broadcastId);
          if (!b) throw new CampaignError('not_found', 'broadcast');
          if (b.body.status !== 'scheduled' && b.body.status !== 'sending' && b.body.status !== 'draft') throw new CampaignError('conflict', 'broadcast_finished');
          ok(await ctx.store.put('broadcast', b.body.broadcastId, { ...b.body, status: 'cancelled' }, { expected: b.version }));
          return done();
        }
        case 'install_starter': {
          const current = await sequenceOf(ctx, request.programKey);
          if (current.body.steps.length) throw new CampaignError('conflict', 'sequence_not_empty');
          const starter = STARTER_SEQUENCES.find(s => s.program === request.programKey)!;
          const waits = starterWaits(starter);
          const ids: string[] = [];
          for (const email of starter.emails) {
            const draft = starterTemplate(request.programKey, email);
            const body: EmailTemplate = emailTemplate.parse({ ...draft, templateId: newId(), version: 1, status: 'draft', updatedAt: at, attorneySignoff: null, approval: null });
            ok(await ctx.store.put('template', body.templateId, body, { expected: null }));
            if (email.kind === 'welcome') ids.push(body.templateId);
          }
          ok(await ctx.store.put('sequence', request.programKey, { programKey: request.programKey, version: current.body.version + 1, status: 'draft',
            steps: ids.map((templateId, i) => ({ stepId: newId(), templateId, waitDays: waits[i]! })), updatedAt: at }, { expected: current.version || null }));
          return done();
        }
        case 'grant_role': {
          if (role.role !== 'marketing_admin') throw new CampaignError('forbidden', 'marketing_admin_required');
          const existing = await ctx.store.get<RoleGrant>('grant', request.personId);
          ok(await ctx.store.put('grant', request.personId, { personId: request.personId, role: request.role, name: request.name, grantedBy: identity.personId, grantedAt: at }, { expected: existing?.version ?? null }));
          return done();
        }
        case 'revoke_role': {
          if (role.role !== 'marketing_admin') throw new CampaignError('forbidden', 'marketing_admin_required');
          if (request.personId === identity.personId) throw new CampaignError('invalid', 'cannot_revoke_self');
          const existing = await ctx.store.get<RoleGrant>('grant', request.personId);
          if (existing) ok(await ctx.store.delete('grant', request.personId, existing.version));
          return done();
        }
      }
    },
  };

  async function releaseSlug(slug: string, practiceId: string) {
    const item = await deps.store.global.get<{ practiceId: string }>('slug', slug);
    if (item?.body.practiceId === practiceId) await deps.store.global.delete('slug', slug, item.version);
  }
}

/** The unsubscribe link for one email: the practice, the list and the address, sealed; the template counts the unsubscribe. */
export function unsubscribeToken(deps: Pick<EngineDeps, 'keys'>, practiceId: string, program: CampaignProgram, hash: string, templateId: string | null): string {
  return seal(deps.keys, 'unsubscribe', { p: practiceId, k: program, h: hash, ...(templateId ? { t: templateId } : {}) });
}
