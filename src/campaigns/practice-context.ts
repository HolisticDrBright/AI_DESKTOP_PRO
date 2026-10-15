import { CAMPAIGN_PROGRAMS, emptySettings, type Allowances, type CampaignProgram, type ContactState, type DomainStatus, type Entitlement, type ListCounts, type PracticeSettings, type RoleGrant } from './contract';
import type { CampaignSesPort } from './ses';
import type { CampaignStore, PracticeStore, TransactOp } from './store';
import type { CampaignKeys } from './tokens';

/**
 * What every part of the engine shares: its configuration, its dependencies, and the practice context it loads
 * once per request or pass (settings, entitlement, allowance, domain status), from which readiness is decided.
 */
export type EngineConfig = {
  /** CAMPAIGN_ENGINE_ENABLED. Off: every public and staff route answers 503 and the send job does nothing. */
  enabled: boolean;
  /** The Desktop's public https origin: program pages, /join pages and the unsubscribe endpoint live there. */
  siteOrigin: string;
  /** The marketing configuration sets, never alp-transactional: one without open and click tracking, one with. */
  configurationSet: string; trackedConfigurationSet: string;
  /** The local part every practice sends from: `<fromLocalPart>@<practice domain>`. */
  fromLocalPart: string;
};
export type EngineDeps = {
  store: CampaignStore; ses: CampaignSesPort; keys: CampaignKeys; config: EngineConfig;
  now?: () => Date; newId?: () => string; pause?: (ms: number) => Promise<void>;
};

export class CampaignError extends Error {
  constructor(readonly category: 'disabled' | 'not_found' | 'not_entitled' | 'forbidden' | 'invalid' | 'conflict' | 'not_ready' | 'unavailable', readonly detail?: string) { super(category); }
}
export const HTTP_STATUS: Record<CampaignError['category'], number> = { disabled: 503, not_found: 404, not_entitled: 403, forbidden: 403, invalid: 400, conflict: 409, not_ready: 409, unavailable: 503 };

export type PracticeContext = {
  store: PracticeStore; settings: PracticeSettings; settingsVersion: number; entitlement: Entitlement | null;
  allowance: { contacts: number; emailsPerMonth: number } | null; domain: DomainStatus | null;
  readiness: { canSend: boolean; missing: string[] };
};

export async function loadPractice(deps: EngineDeps, practiceId: string): Promise<PracticeContext> {
  const store = deps.store.practice(practiceId);
  const [settingsItem, entitlementItem, domainItem, allowancesItem] = await Promise.all([
    store.get<PracticeSettings>('settings', 'current'), store.get<Entitlement>('entitlement', 'current'),
    store.get<DomainStatus>('domain', 'current'), deps.store.global.get<Allowances>('allowances', 'current'),
  ]);
  const settings = settingsItem?.body ?? emptySettings(store.practiceId);
  const entitlement = entitlementItem?.body ?? null;
  const allowance = entitlement?.marketing && entitlement.tier && allowancesItem ? allowancesItem.body.tiers[entitlement.tier] ?? null : null;
  const domain = domainItem?.body && domainItem.body.domain === settings.sendingDomain ? domainItem.body : null;
  const missing: string[] = [];
  if (!deps.config.enabled) missing.push('The campaign engine is switched off (CAMPAIGN_ENGINE_ENABLED).');
  if (!entitlement?.marketing) missing.push('The practice does not hold the marketing package.');
  else if (!allowance) missing.push('No contact allowance is loaded for the practice\'s tier.');
  if (!settings.senderName) missing.push('No sender name is set.');
  if (!settings.mailingAddress) missing.push('No mailing address is set.');
  if (!settings.timeZone) missing.push('No practice time zone is set.');
  if (!settings.joinSlug) missing.push('No sign-up address (practice slug) is set.');
  if (!settings.sendingDomain) missing.push('No sending domain is set.');
  else if (!domain?.verifiedForSending) missing.push('The sending domain is not verified yet: its DNS records have not been found.');
  return { store, settings, settingsVersion: settingsItem?.version ?? 0, entitlement, allowance, domain, readiness: { canSend: missing.length === 0, missing } };
}

export const contactId = (program: CampaignProgram, hash: string) => `${program}:${hash}`;
export type ContactBody = {
  programKey: CampaignProgram; emailHash: string; email: string; firstName: string | null; state: ContactState;
  consentVersion: string; createdAt: string; confirmedAt: string | null; stateAt: string;
  enrollment: { sequenceVersion: number; anchorAt: string; sentStepIds: string[]; lastSentStepId: string | null; lastSentPosition: number; lastSentAt: string | null } | null;
};
export const COUNTED_STATES = ['confirmed', 'unsubscribed', 'bounced', 'complained'] as const satisfies readonly (keyof ListCounts)[];

/** The counter changes that go with a contact moving from one state to another, inside the same transaction. */
export function stateChangeOps(program: CampaignProgram, from: ContactState | null, to: ContactState): TransactOp[] {
  const ops: TransactOp[] = [];
  const counted = (state: ContactState | null): state is (typeof COUNTED_STATES)[number] => !!state && (COUNTED_STATES as readonly string[]).includes(state);
  if (counted(from) && from !== to) ops.push({ op: 'increment', kind: 'counter', id: `list-${program}`, field: from, by: -1 });
  if (counted(to) && from !== to) ops.push({ op: 'increment', kind: 'counter', id: `list-${program}`, field: to, by: 1 });
  return ops;
}

export async function listCounts(store: PracticeStore): Promise<{ programKey: CampaignProgram; counts: ListCounts }[]> {
  return Promise.all(CAMPAIGN_PROGRAMS.map(async programKey => {
    const item = await store.get<Record<string, number>>('counter', `list-${programKey}`);
    const body = item?.body ?? {};
    return { programKey, counts: { confirmed: Math.max(0, body.confirmed ?? 0), unsubscribed: Math.max(0, body.unsubscribed ?? 0), bounced: Math.max(0, body.bounced ?? 0), complained: Math.max(0, body.complained ?? 0) } };
  }));
}

export async function roleOf(store: PracticeStore, personId: string): Promise<RoleGrant | null> {
  return (await store.get<RoleGrant>('grant', personId))?.body ?? null;
}

/** Local hour in a zone; sends happen only from 08:00 to 20:00 there. */
export const SEND_HOURS = Object.freeze({ start: 8, end: 20 });
export function localHour(at: Date, zone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(at));
}
export function withinSendHours(at: Date, zone: string): boolean {
  const hour = localHour(at, zone);
  return hour >= SEND_HOURS.start && hour < SEND_HOURS.end;
}
/** The next moment the zone's local clock reads 08:00 (searched in 15-minute steps; daylight-saving safe). */
export function nextSendWindow(at: Date, zone: string): Date {
  let t = new Date(Math.ceil(at.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 4 * 30; i++) {
    if (withinSendHours(t, zone)) return t;
    t = new Date(t.getTime() + 900_000);
  }
  return t;
}
export const DAY_MS = 86_400_000;
