if (typeof window !== 'undefined') throw new Error('workforce-account-reconciliation is server-only');
import type { ClinicalCoreDatabase } from './database';

/**
 * Read-only reconciliation of existing workforce accounts before the move from immutable Cognito claims to current
 * clinic membership (docs/workforce-membership-authority-decision-2026-10-15.md, "Existing practitioners require a
 * backfill/shadow comparison"). It changes nothing: it is given a Cognito user export the operator already holds, and it
 * reads the database once, in a READ ONLY transaction, with one SELECT.
 *
 * For each Cognito subject it compares: the bound database person, the approved (active, clinical) memberships, the
 * legacy immutable claims, and what the current-membership setter would admit for each clinic. It reports what does
 * not line up and decides nothing:
 *
 * - `binding_ambiguous`: the legacy `custom:person_id` names another person than the one bound to the subject, the
 *   directory's email digest differs from the account's, or two subjects share one verified address.
 * - `multiple_active_clinics`: more than one clinic would admit the subject. The legacy pre-token candidate refuses
 *   these; under current membership each session selects one.
 * - `disabled_account_with_membership` / `disabled_identity`: Cognito and the database disagree about whether the
 *   person may sign in at all.
 * - `stale_legacy_claim`: the legacy `custom:organization_id` names a clinic the setter would not admit now (removed,
 *   suspended, demoted to a non-clinical role, or the clinic itself inactive).
 * - `revoked_membership`, `held_clinic`: informational; neither is access.
 * - `unbound`: a Cognito account with no database identity: an applicant, or a direct sign-up. Not access.
 * - A database that cannot be read makes every subject `unknown`, never `consistent`.
 */
export type CognitoWorkforceUser = {
  subject: string;
  enabled: boolean;
  /** Cognito UserStatus, as exported. */
  status: string;
  /** SHA-256 of the normalized verified email, computed by the operator's export, never the address itself. */
  emailSha256: string | null;
  legacy: { personId: string | null; organizationId: string | null; productionBound: boolean | null };
};
type MembershipRow = { organization_id: string; role: string; status: string; organization_status: string; admitted: boolean };
export type WorkforceAccountRow = {
  identity_subject: string; person_id: string; identity_status: string; person_status: string; production_bound: boolean;
  directory_email_sha256: string | null; memberships: MembershipRow[] | string;
};
export type ReconciliationFinding = 'unbound' | 'unconfirmed_account' | 'binding_ambiguous' | 'multiple_active_clinics'
  | 'disabled_account_with_membership' | 'disabled_identity' | 'stale_legacy_claim' | 'revoked_membership' | 'held_clinic';
export type SubjectReconciliation = {
  subject: string;
  outcome: 'consistent' | 'attention' | 'unknown';
  personId: string | null;
  /** Clinics the current-membership setter would admit now, each selectable in its own session. */
  admittedClinics: string[];
  findings: ReconciliationFinding[];
};
export type ReconciliationReport = {
  contract: 'workforce-account-reconciliation/1';
  database: 'read' | 'unavailable';
  subjects: SubjectReconciliation[];
  /** Counts only: no email, no name, no clinic label. */
  totals: Record<ReconciliationFinding | 'consistent' | 'unknown', number>;
};

/** The one statement the reconciliation runs, after `set transaction read only`. Mirrors the setter's admission rule. */
export const WORKFORCE_RECONCILIATION_QUERY = `select i.identity_subject, i.person_id, i.status as identity_status, p.status as person_status,
  i.production_bound, d.email_sha256 as directory_email_sha256,
  coalesce((select jsonb_agg(jsonb_build_object('organization_id',m.organization_id,'role',m.role,'status',m.status,
      'organization_status',o.status,
      'admitted', m.status='active' and m.role in ('owner','admin','practitioner','staff') and o.status='active'
        and o.environment='production-clinical' and o.data_classification='clinical_phi' and o.contains_phi is true
        and i.status='active' and i.production_bound is true and p.status='active' and p.contains_phi is true)
      order by m.organization_id)
    from clinical_core.organization_memberships m join clinical_core.organizations o on o.id=m.organization_id
    where m.person_id=i.person_id),'[]'::jsonb) as memberships
from clinical_core.identities i
join clinical_core.persons p on p.id=i.person_id
left join clinical_core.workforce_identity_directory d on d.identity_subject=i.identity_subject and d.status='active'
where i.identity_pool='workforce' and i.identity_subject = any($1::text[])
order by i.identity_subject`;

const FINDINGS: ReconciliationFinding[] = ['unbound', 'unconfirmed_account', 'binding_ambiguous', 'multiple_active_clinics',
  'disabled_account_with_membership', 'disabled_identity', 'stale_legacy_claim', 'revoked_membership', 'held_clinic'];
const ATTENTION = new Set<ReconciliationFinding>(['binding_ambiguous', 'multiple_active_clinics', 'disabled_account_with_membership',
  'disabled_identity', 'stale_legacy_claim']);
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reads the database once, read-only. Throws only on a malformed export; a database failure is `unavailable`. */
export async function reconcileWorkforceAccounts(database: ClinicalCoreDatabase, users: readonly CognitoWorkforceUser[],
  holds: (tx: Parameters<Parameters<ClinicalCoreDatabase['transaction']>[0]>[0]) => Promise<ReadonlySet<string>> = activationHolds): Promise<ReconciliationReport> {
  if (users.length > 10_000 || users.some(user => !SUBJECT.test(user.subject))) throw new Error('reconciliation_export_invalid');
  let rows: WorkforceAccountRow[] | null = null;
  let held: ReadonlySet<string> = new Set();
  try {
    await database.transaction(async tx => {
      await tx.query('set transaction read only');
      rows = (await tx.query<WorkforceAccountRow>(WORKFORCE_RECONCILIATION_QUERY, [users.map(user => user.subject.toLowerCase())])).rows;
      held = await holds(tx);
    });
  } catch {
    rows = null;
  }
  return reconcile(users, rows, held);
}

/** Clinics held for activation (the BLOCKED approval-authority candidate), read in the same read-only transaction; none
 * where that candidate is not applied. */
export async function activationHolds(tx: Parameters<Parameters<ClinicalCoreDatabase['transaction']>[0]>[0]): Promise<ReadonlySet<string>> {
  const present = await tx.query<{ present: boolean }>(`select to_regclass('clinical_private.workforce_clinic_activation_holds') is not null as present`);
  if (present.rows[0]?.present !== true) return new Set();
  const { rows } = await tx.query<{ organization_id: string }>('select h.organization_id::text as organization_id from clinical_private.workforce_clinic_activation_holds h');
  return new Set(rows.map(row => row.organization_id));
}

export function reconcile(users: readonly CognitoWorkforceUser[], rows: readonly WorkforceAccountRow[] | null, heldClinics: ReadonlySet<string> = new Set()): ReconciliationReport {
  const bySubject = new Map((rows ?? []).map(row => [row.identity_subject.toLowerCase(), row]));
  const byDigest = new Map<string, Set<string>>();
  for (const user of users) if (user.emailSha256) byDigest.set(user.emailSha256, (byDigest.get(user.emailSha256) ?? new Set()).add(user.subject.toLowerCase()));
  const subjects = users.map((user): SubjectReconciliation => {
    const subject = user.subject.toLowerCase();
    if (rows === null) return { subject, outcome: 'unknown', personId: null, admittedClinics: [], findings: [] };
    const findings = new Set<ReconciliationFinding>();
    if (user.status !== 'CONFIRMED') findings.add('unconfirmed_account');
    if (user.emailSha256 && (byDigest.get(user.emailSha256)?.size ?? 0) > 1) findings.add('binding_ambiguous');
    const row = bySubject.get(subject);
    if (!row) {
      findings.add('unbound');
      if (user.legacy.personId || user.legacy.organizationId) findings.add('binding_ambiguous');
      return { subject, outcome: [...findings].some(f => ATTENTION.has(f)) ? 'attention' : 'consistent', personId: null, admittedClinics: [], findings: [...findings] };
    }
    const memberships = (typeof row.memberships === 'string' ? JSON.parse(row.memberships) : row.memberships) as MembershipRow[];
    const admitted = memberships.filter(m => m.admitted).map(m => m.organization_id);
    if (user.legacy.personId && user.legacy.personId.toLowerCase() !== row.person_id.toLowerCase()) findings.add('binding_ambiguous');
    if (user.emailSha256 && row.directory_email_sha256 && user.emailSha256 !== row.directory_email_sha256) findings.add('binding_ambiguous');
    if (admitted.length > 1) findings.add('multiple_active_clinics');
    if (!user.enabled && admitted.length > 0) findings.add('disabled_account_with_membership');
    if (user.enabled && (row.identity_status !== 'active' || row.person_status !== 'active')) findings.add('disabled_identity');
    if (user.legacy.organizationId && !admitted.includes(user.legacy.organizationId.toLowerCase())) findings.add('stale_legacy_claim');
    if (memberships.some(m => m.status === 'suspended')) findings.add('revoked_membership');
    if (memberships.some(m => heldClinics.has(m.organization_id))) findings.add('held_clinic');
    return { subject, outcome: [...findings].some(f => ATTENTION.has(f)) ? 'attention' : 'consistent', personId: row.person_id, admittedClinics: admitted, findings: [...findings].sort() };
  });
  const totals = Object.fromEntries([...FINDINGS, 'consistent', 'unknown'].map(key => [key, 0])) as ReconciliationReport['totals'];
  for (const entry of subjects) {
    if (entry.outcome === 'unknown') totals.unknown += 1;
    if (entry.outcome === 'consistent') totals.consistent += 1;
    for (const finding of entry.findings) totals[finding] += 1;
  }
  return { contract: 'workforce-account-reconciliation/1', database: rows === null ? 'unavailable' : 'read', subjects, totals };
}
