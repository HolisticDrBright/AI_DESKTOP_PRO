import { createCampaignHttpHandler } from './http';
import { createMemoryCampaignStore } from './memory-store';
import { createCampaignOperator } from './operator';
import type { EngineConfig, EngineDeps } from './practice-context';
import { createPublicCampaigns } from './public';
import { createSendJob } from './send-job';
import { createSesEventHandler } from './ses-events';
import { createFakeCampaignSes } from './ses';
import { createFictionalStaffRevocationSignal } from './staff-revocation';
import { deriveCampaignKeys } from './tokens';
import { createWorkforceCampaigns, type WorkforceIdentity } from './workforce';
import type { MarketingTier, WorkforceRequest } from './contract';

/**
 * A whole campaign engine over fictional parts, for tests and the local fixture: the in-memory store, a fake SES at
 * its SDK boundary, a fixed key and a movable clock. Fictional practices, people and addresses only.
 */
export const FICTIONAL_ALLOWANCES = Object.freeze({ version: 'fictional-1', tiers: { addon: { contacts: 10_000, emailsPerMonth: 50_000 }, growth: { contacts: 10_000, emailsPerMonth: 50_000 }, complete: { contacts: 25_000, emailsPerMonth: 100_000 } } });
export const TOPIC = 'arn:aws:sns:us-east-2:111122223333:fictional-campaign-events';

export function fictionalEngine(options: { start?: string; config?: Partial<EngineConfig>; staffRevocation?: 'unconfigured' } = {}) {
  let clock = new Date(options.start ?? '2026-10-15T17:00:00Z').getTime();
  const now = () => new Date(clock);
  const store = createMemoryCampaignStore({ now: () => clock });
  const ses = createFakeCampaignSes();
  const revocations = createFictionalStaffRevocationSignal();
  let ids = 0;
  const deps: EngineDeps = {
    store, ses: ses.port, keys: deriveCampaignKeys(Buffer.alloc(32, 7)), now, pause: async () => {},
    ...(options.staffRevocation === 'unconfigured' ? {} : { staffRevocation: revocations.signal }),
    newId: () => `0e000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    config: { enabled: true, siteOrigin: 'https://clinic.fictional.example', configurationSet: 'alp-marketing', trackedConfigurationSet: 'alp-marketing-tracked', fromLocalPart: 'updates', ...options.config },
  };
  const publicSide = createPublicCampaigns(deps), staff = createWorkforceCampaigns(deps), operator = createCampaignOperator(store, now);
  return {
    deps, store, ses, publicSide, staff, operator, revocations,
    pass: createSendJob(deps), events: createSesEventHandler({ ...deps, topicArn: TOPIC }), http: createCampaignHttpHandler(deps),
    now, advance(ms: number) { clock += ms; }, set(iso: string) { clock = Date.parse(iso); },
    /** A practice holding the marketing package, with every send setting in place and a verified domain. */
    async readyPractice(p: { practiceId: string; slug: string; name: string; domain: string; admin: WorkforceIdentity & { name: string }; tier?: MarketingTier; zone?: string }) {
      await operator.loadAllowances(FICTIONAL_ALLOWANCES);
      await operator.grantMarketing(p.practiceId, p.tier ?? 'growth', 'fictional-operator', { personId: p.admin.personId, name: p.admin.name });
      const ask = (request: WorkforceRequest) => staff.handle(p.admin, request);
      const first = await ask({ action: 'overview' });
      if (first.action !== 'overview') throw new Error('overview');
      await ask({ action: 'update_settings', expectedVersion: first.settings.version, joinSlug: p.slug, senderName: p.name, mailingAddress: '100 Fictional Way, Exampletown, CA 90000', timeZone: p.zone ?? 'America/Los_Angeles', trackOpensAndClicks: false });
      await ask({ action: 'register_domain', domain: p.domain });
      ses.verify(p.domain);
      await ask({ action: 'refresh_domain' });
      return ask;
    },
  };
}

/** The confirm link's token from a confirmation email in the fake outbox. */
export function tokenFrom(text: string, path: '/join/confirm' | '/join/unsubscribe' | '/api/public/campaigns/unsubscribe'): string {
  const match = new RegExp(`${path.replace(/\//g, '\\/')}\\?t=([A-Za-z0-9_-]+)`).exec(text);
  if (!match) throw new Error(`no ${path} link`);
  return match[1]!;
}
