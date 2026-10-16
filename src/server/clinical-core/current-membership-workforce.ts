if (typeof window !== 'undefined') throw new Error('current-membership-workforce is server-only');
import type { ApiGatewayV2Event } from './aws-identity-api';
import type { CurrentWorkforcePrincipal, ProductionClinicalRequestContext } from './aws-identity-consent';
import { clinicalUuid, type ClinicalCoreTransaction } from './database';

/**
 * The workforce side of a dedicated clinical API (messaging, programs) under the unactivated `database_current`
 * authority, where the clinic and the acting person come from current rows and never from the token.
 *
 * The token supplies only who signed in: the configured workforce issuer and audience, an ID token, a UUID `sub`, a
 * verified email, no synthetic attestation, and the family's existing session freshness (live `exp`, plausible `iat`,
 * `auth_time` within 15 minutes). `custom:person_id`, `custom:organization_id`, `custom:production_bound`, roles and
 * groups are ignored. The request names exactly one clinic in `x-alp-selected-organization-id`, and it must be the
 * clinic this API serves; a missing, duplicated or other clinic is refused before any database call.
 *
 * Then, inside the operation's own transaction, `clinical_private.set_current_workforce_context` (the UNREGISTERED
 * current-membership candidate, infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql)
 * reads the identity, person, clinic and membership rows for that subject and clinic, locks them for the rest of the
 * transaction and sets the request context. The operation runs after it, under its own unchanged SQL checks.
 * `set_request_context`, which trusts a claimed person and clinic, is never called on this path.
 */
export const SELECTED_CLINIC_REQUEST_HEADER = 'x-alp-selected-organization-id';

/** prosrc SHA-256 of `clinical_private.set_current_workforce_context` in the candidate; a test holds it to the file. */
export const CURRENT_MEMBERSHIP_SETTER_BODY_SHA256 = '7054db763a6ff38b00a504a09398dcbd60f69b6476b6c85bab36da496d6e0cd6';

/** The two statements the current-membership path sends, exported so a restricted credential can allow exactly these. */
export const CURRENT_MEMBERSHIP_SETTER_STATEMENT = 'select clinical_private.set_current_workforce_context($1,$2,$3) as binding';
export const CURRENT_MEMBERSHIP_SETTER_BOUND_STATEMENT = `select coalesce((select p.prosecdef and p.prokind='f'
      and p.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1
      and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE')
    from pg_proc p where p.oid=to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)')),false) as valid`;

export class CurrentMembershipRefusal extends Error {
  constructor(readonly code: 'reauth_required' | 'identity_refused') { super(code); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = ['owner', 'admin', 'practitioner', 'staff'] as const;
export type CurrentWorkforceRole = typeof ROLES[number];

export function currentMembershipWorkforcePrincipal(event: ApiGatewayV2Event,
  c: { workforceIssuer: string; workforceAudience: string; organizationId: string }, now: number): CurrentWorkforcePrincipal {
  const v = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const numericTime = (n: unknown) => (typeof n === 'number' || typeof n === 'string' && /^\d+$/.test(n))
    && Number.isSafeInteger(Number(n)) && Number(n) > 0;
  if (v.iss !== c.workforceIssuer || v.aud !== c.workforceAudience || v.token_use !== 'id'
    || ![true, 'true'].includes(v.email_verified as string | boolean)
    || [true, 'true'].includes(v['custom:synthetic_attested'] as string | boolean)
    || typeof v.sub !== 'string' || !UUID.test(v.sub) || ![v.exp, v.iat, v.auth_time].every(numericTime)
    || !Number.isFinite(now) || Number(v.exp) * 1000 <= now || Number(v.iat) >= Number(v.exp)
    || Number(v.iat) * 1000 > now + 60000 || Number(v.auth_time) > Number(v.iat)
    || now - Number(v.auth_time) * 1000 > 15 * 60000) throw new CurrentMembershipRefusal('reauth_required');
  // Two selections in one request are ambiguous: refused, not decided by whichever is read first.
  const selected = Object.entries(event.headers ?? {}).filter(([key]) => key.toLowerCase() === SELECTED_CLINIC_REQUEST_HEADER);
  const organizationId = selected.length === 1 ? (selected[0]![1] ?? '').toLowerCase() : '';
  if (!UUID.test(organizationId) || organizationId !== c.organizationId.toLowerCase()) throw new CurrentMembershipRefusal('identity_refused');
  return { subject: v.sub.toLowerCase(), selectedOrganizationId: organizationId };
}

/**
 * Binds the transaction to the current membership of `principal` and returns the request context the operation runs
 * under, with the role current rows hold. A membership for any other clinic, or none, is refused by the setter
 * (`workforce_membership_refused`), and the whole transaction with it.
 */
export async function bindCurrentWorkforceContext(tx: ClinicalCoreTransaction, principal: CurrentWorkforcePrincipal,
  purpose: 'clinical_data'): Promise<{ context: ProductionClinicalRequestContext; role: CurrentWorkforceRole }> {
  const { rows } = await tx.query<{ binding: unknown }>(CURRENT_MEMBERSHIP_SETTER_STATEMENT,
    [principal.subject, clinicalUuid(principal.selectedOrganizationId), purpose]);
  let binding = rows[0]?.binding;
  if (typeof binding === 'string') { try { binding = JSON.parse(binding); } catch { binding = null; } }
  const row = binding && typeof binding === 'object' && !Array.isArray(binding) ? binding as Record<string, unknown> : {};
  if (typeof row.personId !== 'string' || !UUID.test(row.personId) || typeof row.organizationId !== 'string'
    || row.organizationId.toLowerCase() !== principal.selectedOrganizationId
    || typeof row.role !== 'string' || !(ROLES as readonly string[]).includes(row.role)) throw new CurrentMembershipRefusal('identity_refused');
  return { role: row.role as CurrentWorkforceRole, context: {
    actorPersonId: row.personId.toLowerCase(), organizationId: principal.selectedOrganizationId, identitySubject: principal.subject,
    identityPool: 'workforce', purpose, environment: 'production-clinical', dataClassification: 'clinical_phi',
    containsPhi: true, realPatientData: true, productionBound: true,
  } };
}

/**
 * The deployed-contract check for the setter, through the API role, before business SQL: present with the reviewed
 * body, SECURITY DEFINER, an empty search_path, callable by `clinical_core_api` and never by PUBLIC. While the candidate
 * is unregistered this is false, and a `database_current` request answers 503 without reaching any operation.
 */
export async function currentMembershipSetterBound(tx: ClinicalCoreTransaction): Promise<boolean> {
  const { rows } = await tx.query<{ valid: boolean }>(CURRENT_MEMBERSHIP_SETTER_BOUND_STATEMENT, [CURRENT_MEMBERSHIP_SETTER_BODY_SHA256]);
  return rows[0]?.valid === true;
}
