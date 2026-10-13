import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LEAD_CAMPAIGNS_CONTRACT, LEAD_PROGRAMS, type CampaignCounts, type LeadProgram } from '@/contracts/leadCampaigns';

/**
 * The campaign directory port and its Dittofeed implementation. Dittofeed is installed beside the
 * Desktop as its own service from a pinned release; nothing of its source is in this repository.
 *
 * Writes use Dittofeed's public write key only (identify, and the DFSubscriptionChange event that
 * subscribes or unsubscribes a user from an opt-in subscription group). The admin key, which has no
 * documented read-only scope, is used only for counts and never leaves this service: the Desktop asks
 * this service for counts and receives numbers, not people.
 *
 * Endpoint shapes are from Dittofeed's documentation source at the v0.23/v0.24 line; they have not
 * been exercised against a running instance (see the return document).
 */
export interface CampaignDirectory {
  confirm(input: { userId: string; email: string; firstName: string | null; program: LeadProgram; consentVersion: string; confirmedAt: string }): Promise<void>;
  unsubscribeAll(userId: string): Promise<void>;
  counts(): Promise<CampaignCounts>;
}
export type DittofeedConfig = {
  baseUrl: string; workspaceId: string; writeKey: string; adminKey: string;
  /** One OPT-IN subscription group per program (so each list starts empty). */
  groups: Record<LeadProgram, string>;
};
export class DirectoryError extends Error { constructor() { super('campaign_directory_unavailable'); this.name = 'DirectoryError'; } }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export function createDittofeedDirectory(config: DittofeedConfig, fetcher: Fetch = fetch as unknown as Fetch, timeoutMs = 5000): CampaignDirectory {
  const base = config.baseUrl.replace(/\/$/, '');
  async function call(path: string, method: 'GET' | 'POST', auth: 'write' | 'admin', body?: unknown) {
    const headers: Record<string, string> = { authorization: auth === 'write' ? `Basic ${config.writeKey}` : `Bearer ${config.adminKey}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Awaited<ReturnType<Fetch>>;
    try { response = await fetcher(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new DirectoryError(); }
    if (!response.ok) throw new DirectoryError();
    return response.json().catch(() => null);
  }
  const change = (userId: string, subscriptionId: string, action: 'Subscribe' | 'Unsubscribe') =>
    call('/api/public/apps/track', 'POST', 'write', { userId, messageId: randomUUID(), event: 'DFSubscriptionChange', properties: { subscriptionId, action } });
  const q = (params: Record<string, string>) => '?' + new URLSearchParams(params).toString();

  return {
    async confirm({ userId, email, firstName, program, consentVersion, confirmedAt }) {
      // The consent record travels with the person: which wording, for which program, when.
      await call('/api/public/apps/identify', 'POST', 'write', { userId, messageId: randomUUID(),
        traits: { email, ...(firstName ? { firstName } : {}), [`consent_${program.replaceAll('-', '_')}`]: { version: consentVersion, confirmedAt } } });
      await change(userId, config.groups[program], 'Subscribe');
    },
    async unsubscribeAll(userId) {
      for (const program of LEAD_PROGRAMS) await change(userId, config.groups[program], 'Unsubscribe');
    },
    async counts() {
      const lists = [];
      for (const program of LEAD_PROGRAMS) {
        const reply = z.object({ userCount: z.number().int().min(0) }).safeParse(
          await call('/api/admin/users/count', 'POST', 'admin', { workspaceId: config.workspaceId, subscriptionGroupFilter: [config.groups[program]] }));
        if (!reply.success) throw new DirectoryError();
        lists.push({ program, confirmed: reply.data.userCount });
      }
      const broadcasts = z.array(z.object({ id: z.string(), name: z.string(), triggeredAt: z.union([z.number(), z.string()]).nullish() }).passthrough())
        .safeParse(await call('/api/admin/broadcasts' + q({ workspaceId: config.workspaceId }), 'GET', 'admin'));
      if (!broadcasts.success) throw new DirectoryError();
      const recent = broadcasts.data.filter(b => b.triggeredAt != null).sort((a, b) => Date.parse(String(b.triggeredAt)) - Date.parse(String(a.triggeredAt))).slice(0, 10);
      const recentSends = [];
      for (const b of recent) {
        const summary = z.object({ summary: z.object({ deliveries: z.number().int().min(0), bounces: z.number().int().min(0) }).passthrough() }).passthrough()
          .safeParse(await call('/api/admin/analysis/summary' + q({ workspaceId: config.workspaceId, 'broadcastIds[]': b.id }), 'GET', 'admin'));
        if (!summary.success) throw new DirectoryError();
        const at = new Date(typeof b.triggeredAt === 'number' ? b.triggeredAt : Date.parse(String(b.triggeredAt)));
        recentSends.push({ name: b.name.slice(0, 120) || 'Untitled', sentAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
          delivered: summary.data.summary.deliveries, bounced: summary.data.summary.bounces, unsubscribed: null });
      }
      return { contract: LEAD_CAMPAIGNS_CONTRACT, lists, recentSends };
    },
  };
}

/** A fictional directory for tests and fixtures: who is subscribed to what, in memory. */
export function createFictionalDirectory() {
  const members = new Map<string, { email: string; programs: Set<LeadProgram>; consent: Record<string, string> }>();
  let down = false;
  const directory: CampaignDirectory = {
    async confirm({ userId, email, program, consentVersion }) {
      if (down) throw new DirectoryError();
      const m = members.get(userId) ?? { email, programs: new Set<LeadProgram>(), consent: {} };
      m.programs.add(program); m.consent[program] = consentVersion; members.set(userId, m);
    },
    async unsubscribeAll(userId) { if (down) throw new DirectoryError(); members.get(userId)?.programs.clear(); },
    async counts() {
      if (down) throw new DirectoryError();
      return { contract: LEAD_CAMPAIGNS_CONTRACT, lists: LEAD_PROGRAMS.map(program => ({ program, confirmed: [...members.values()].filter(m => m.programs.has(program)).length })), recentSends: [] };
    },
  };
  return { directory, members, setDown(value: boolean) { down = value; } };
}
