import { resolveOrgId } from '@/adapters/config';
import { getClinicalAccessToken } from '@/adapters/session.server';
import type { RequestSession } from '@/server/session';
import { fictionalPersonId } from './program-commerce-runtime';

/**
 * The identity the Studio's commerce routes act under: the practitioner's cookie session first, and
 * the same local/e2e fallback the other live routes use (env demo credentials and `CLINICAL_ORG_ID`,
 * both admitted only inside the contract-fixture boundary). Outside that boundary the cookie session
 * is the only source, so a deployed process with no cookie answers "sign in again", never a guess.
 * The person id is the fictional stand-in the fictional ledgers need; the clinical service derives
 * the real actor from the token itself.
 */
export interface WorkforceIdentity {
  token: string;
  organizationId: string;
  personId: string;
}

export async function resolveWorkforceIdentity(session: RequestSession): Promise<WorkforceIdentity | null> {
  try {
    const token = await getClinicalAccessToken(session.token);
    const organizationId = resolveOrgId(session.orgId);
    return { token, organizationId, personId: fictionalPersonId(session.email ?? `clinic:${organizationId}`) };
  } catch {
    return null;
  }
}
