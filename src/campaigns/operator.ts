import { allowances as allowancesSchema, CAMPAIGN_PROGRAMS, emptySettings, entitlement as entitlementSchema, roleGrant, type Allowances, type CampaignProgram, type Entitlement, type MarketingTier, type PracticeSettings, type RoleGrant } from './contract';
import type { CampaignStore } from './store';

/**
 * Operator actions: what only the people running Desktop Pro do, never a practice and never a route. Granting
 * or removing the `marketing` entitlement (the Growth and Complete tiers, or the add-on), loading the contact and
 * email allowances as data, the practice's first `marketing_admin`, and which programs need an attorney's sign-off
 * before an email is approved (Brandon's practice: weight loss and diabetes).
 *
 * These are called from a reviewed operator script with the campaign table's credentials; no API route reaches them.
 */
export function createCampaignOperator(store: CampaignStore, now: () => Date = () => new Date()) {
  return {
    async loadAllowances(data: Allowances): Promise<void> {
      const value = allowancesSchema.parse(data);
      const current = await store.global.get('allowances', 'current');
      if (await store.global.put('allowances', 'current', value, { expected: current?.version ?? null }) === 'conflict') throw new Error('allowances_conflict');
    },
    async grantMarketing(practiceId: string, tier: MarketingTier, grantedBy: string, firstAdmin: { personId: string; name: string }): Promise<void> {
      const practice = store.practice(practiceId);
      const at = now().toISOString();
      const value: Entitlement = entitlementSchema.parse({ marketing: true, tier, grantedBy, grantedAt: at });
      const current = await practice.get('entitlement', 'current');
      if (await practice.put('entitlement', 'current', value, { expected: current?.version ?? null }) === 'conflict') throw new Error('entitlement_conflict');
      const indexed = await store.global.get('marketing_practice', practice.practiceId);
      if (!indexed) await store.global.put('marketing_practice', practice.practiceId, { since: at }, { expected: null });
      const admin: RoleGrant = roleGrant.parse({ personId: firstAdmin.personId, role: 'marketing_admin', name: firstAdmin.name, grantedBy, grantedAt: at });
      const existing = await practice.get('grant', firstAdmin.personId);
      await practice.put('grant', firstAdmin.personId, admin, { expected: existing?.version ?? null });
    },
    /** Without the entitlement nothing sends and the sign-up page does not exist; the practice's lists are kept, untouched. */
    async revokeMarketing(practiceId: string, revokedBy: string): Promise<void> {
      const practice = store.practice(practiceId);
      const current = await practice.get('entitlement', 'current');
      if (current) await practice.put('entitlement', 'current', { marketing: false, tier: null, grantedBy: revokedBy, grantedAt: now().toISOString() }, { expected: current.version });
      const indexed = await store.global.get('marketing_practice', practice.practiceId);
      if (indexed) await store.global.delete('marketing_practice', practice.practiceId, indexed.version);
    },
    async setAttorneySignoffPrograms(practiceId: string, programs: CampaignProgram[]): Promise<void> {
      const practice = store.practice(practiceId);
      if (programs.some(p => !(CAMPAIGN_PROGRAMS as readonly string[]).includes(p))) throw new Error('program_invalid');
      const current = await practice.get<PracticeSettings>('settings', 'current');
      const body = current?.body ?? emptySettings(practice.practiceId);
      await practice.put('settings', 'current', { ...body, attorneySignoffPrograms: [...new Set(programs)], version: body.version + 1 }, { expected: current?.version ?? null });
    },
  };
}
