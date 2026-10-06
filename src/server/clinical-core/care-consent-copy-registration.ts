if (typeof window !== 'undefined') throw new Error('care-consent-copy-registration is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { careConsentScope } from '../../contracts/careConnections';
import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { assertCareConnectionsUpgrade, CARE_CONNECTIONS_UPGRADE, CareConnectionsUpgradeError, verifyCareConsentRegistrationTarget } from './care-connections-schema-upgrade';

const schema = z.object({ contract: z.literal('care-consent-copy/1'), artifactId: z.string().uuid(), organizationId: z.string().uuid(),
  scope: careConsentScope, artifactVersion: z.string().min(1).max(64), contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().min(1).max(16000) }).strict();
export type CareConsentCopy = z.infer<typeof schema>;
type Category = 'copy_invalid' | 'approval_required' | 'copy_conflict' | 'target_refused' | 'operation_failed' | 'verification_failed';
export class CareConsentCopyError extends Error { constructor(readonly category: Category) { super(category); } }
const fail = (category: Category): never => { throw new CareConsentCopyError(category); };
export function parseCareConsentCopy(value: unknown): CareConsentCopy {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail('copy_invalid');
  const copy = parsed.data;
  // Approval covers the exact UTF-8 text, not LF-normalized or trimmed substitutes.
  if (!copy.content.trim() || copy.content.includes('\0') || Buffer.byteLength(copy.content, 'utf8') > 16000
    || Buffer.from(copy.content, 'utf8').toString('utf8') !== copy.content
    || createHash('sha256').update(copy.content, 'utf8').digest('hex') !== copy.contentSha256) fail('copy_invalid');
  // UUID spelling is not consent text. PostgreSQL returns lower-case UUIDs;
  // retain the exact approved text while accepting equivalent UUID spelling.
  return { ...copy, artifactId: copy.artifactId.toLowerCase(), organizationId: copy.organizationId.toLowerCase() };
}
export type CareConsentCopyMode = 'inventory' | 'inspect' | 'rehearse' | 'register';
type Receipt = { contract: 'care-consent-copy-registration/1'; command: CareConsentCopyMode; execution: 'qualification';
  phiAllowed: false; activation: 'blocked'; migrationCount: 105; migrationReleaseSha256: string;
  approvalsCreated: false; grantsCreated: false; copyInserted: boolean; copyPresent: boolean | null;
  artifactId: string | null; contentSha256: string | null; rolledBack: boolean;
  inventory?: { approvedArtifacts: number; registeredCopies: number } };
class RollbackRegistration extends Error { constructor(readonly receipt: Receipt, readonly priorPresent: boolean) { super('rollback_registration'); } }

async function approvedCopy(tx: ClinicalCoreTransaction, copy: CareConsentCopy, lock: boolean) {
  if (lock) await tx.query("select pg_advisory_xact_lock(hashtextextended('care-consent-release:'||$1::text||':'||$2,1))",
    [clinicalUuid(copy.organizationId), copy.scope]);
  const approved = await tx.query<{ id: string }>(`select a.id from clinical_core.consent_artifacts a
    join clinical_core.organizations o on o.id=a.organization_id and o.status='active'
    join clinical_core.identities i on i.person_id=a.approved_by_person_id and i.identity_pool='workforce'
      and i.status='active' and i.production_bound
    join clinical_core.persons p on p.id=i.person_id and p.status='active'
    join clinical_core.organization_memberships m on m.organization_id=a.organization_id and m.person_id=i.person_id
      and m.status='active' and m.role in ('owner','admin','practitioner')
    where a.id=$1 and a.organization_id=$2 and a.scope=$3 and a.artifact_version=$4
      and a.content_sha256=$5 and a.status='approved' and a.approved_at<=clock_timestamp()
      and a.id=(select id from clinical_core.consent_artifacts where organization_id=$2 and scope=$3 and status='approved'
        order by approved_at desc,created_at desc,id desc limit 1)${lock ? ' for share of a,o,i,p,m' : ''}`,
    [clinicalUuid(copy.artifactId), clinicalUuid(copy.organizationId), copy.scope, copy.artifactVersion, copy.contentSha256]);
  if (approved.rows.length !== 1 || approved.rows[0].id !== copy.artifactId) fail('approval_required');
  const rows = (await tx.query<{ organization_id: string; content: string; content_sha256: string }>(
    'select organization_id,content,content_sha256 from clinical_core.care_consent_texts where artifact_id=$1', [clinicalUuid(copy.artifactId)])).rows;
  if (rows.length > 1 || rows.some(row => row.organization_id !== copy.organizationId
    || row.content_sha256 !== copy.contentSha256 || row.content !== copy.content)) fail('copy_conflict');
  return rows.length === 1;
}

/** Registers only existing approved copy, never its approval or patient consent.
 * Qualification boundary only. Read inventory/inspection cannot write. Rehearsal
 * throws to roll back and independently inspects afterward. No automatic replay
 * follows an uncertain insert/commit. Registered_at + immutable artifact linkage
 * are not a separate application event for the AWS operator's identity. */
export async function runCareConsentCopyRegistration(database: ClinicalCoreDatabase, suppliedMigrations: ClinicalCoreMigration[],
  suppliedConfiguration: QualificationUpgradeConfiguration, command: CareConsentCopyMode, suppliedCopy?: unknown): Promise<Receipt> {
  const migrations = suppliedMigrations.map(m => ({ ...m })), configuration = { ...suppliedConfiguration };
  assertCareConnectionsUpgrade(configuration, migrations);
  if (!['inventory', 'inspect', 'rehearse', 'register'].includes(command) || command === 'inventory' && suppliedCopy !== undefined)
    fail('copy_invalid');
  const copy = command === 'inventory' ? undefined : parseCareConsentCopy(suppliedCopy);
  const write = command === 'rehearse' || command === 'register';
  const base: Receipt = { contract: 'care-consent-copy-registration/1', command, execution: 'qualification', phiAllowed: false,
    activation: 'blocked', migrationCount: 105, migrationReleaseSha256: CARE_CONNECTIONS_UPGRADE.to, approvalsCreated: false,
    grantsCreated: false, copyInserted: false, copyPresent: null, artifactId: copy?.artifactId ?? null,
    contentSha256: copy?.contentSha256 ?? null, rolledBack: false };
  try {
    return await database.transaction(async tx => {
      // READ COMMITTED after the scope lock sees the current approved release.
      await tx.query(write ? 'set transaction isolation level read committed' : 'set transaction isolation level repeatable read read only');
      await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'");
      await tx.query('set local row_security=off');
      if (write) {
        if ((await tx.query<{ acquired: boolean }>("select pg_try_advisory_xact_lock(hashtext('ai-desktop-pro:production-clinical-core-migrations')) as acquired")).rows[0]?.acquired !== true)
          fail('target_refused');
        await tx.query('lock table clinical_core.care_consent_texts,clinical_core.schema_migrations in share row exclusive mode');
      }
      await verifyCareConsentRegistrationTarget(tx, migrations, configuration);
      if (!copy) {
        const row = (await tx.query<{ approved: number; copies: number }>(`select
          (select count(*)::int from clinical_core.consent_artifacts where status='approved') as approved,
          (select count(*)::int from clinical_core.care_consent_texts) as copies`)).rows[0];
        if (!row || !Number.isSafeInteger(row.approved) || row.approved < 0 || !Number.isSafeInteger(row.copies) || row.copies < 0)
          fail('verification_failed');
        return { ...base, inventory: { approvedArtifacts: row.approved, registeredCopies: row.copies } };
      }
      const priorPresent = await approvedCopy(tx, copy, write);
      if (write && !priorPresent) {
        await tx.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)',
          [clinicalUuid(copy.artifactId), clinicalUuid(copy.organizationId), copy.content, copy.contentSha256]);
        if (!await approvedCopy(tx, copy, true)) fail('verification_failed');
      }
      const receipt = { ...base, copyInserted: write && !priorPresent, copyPresent: write || priorPresent };
      if (command === 'rehearse') throw new RollbackRegistration(receipt, priorPresent);
      return receipt;
    });
  } catch (error) {
    if (error instanceof RollbackRegistration) {
      const inspected = await runCareConsentCopyRegistration(database, migrations, configuration, 'inspect', copy);
      if (inspected.copyPresent !== error.priorPresent) fail('verification_failed');
      return { ...error.receipt, copyInserted: false, copyPresent: inspected.copyPresent, rolledBack: true };
    }
    if (error instanceof CareConsentCopyError || error instanceof CareConnectionsUpgradeError) throw error;
    // Provider/SQL text may contain sensitive parameters. Expose only fixed categories.
    throw new CareConsentCopyError('operation_failed');
  }
}
