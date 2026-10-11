if (typeof window !== 'undefined') throw new Error('program media settlement is server-only');
import { z } from 'zod';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { ProgramMediaError, type ProgramMediaAbsenceProof, type ProgramMediaLedger } from './program-media-authoring';

/** SQL-backed settlement component, not a workforce authentication factory,
 * complete ledger adapter, approved release or native store. Private functions
 * in the distinct BLOCKED candidate grant the API role nothing. A future
 * reviewed authoring family must install it alongside the SAME artifact ledger,
 * and bind real identity, program rights, function hashes and restricted DB.
 * Never substitute an administrative credential to make this source run live. */
export function createProgramMediaSettlementSource(database: ClinicalCoreDatabase) {
  const uuid = z.uuid();
  function parameters(c: ClinicalRequestContext, artifactId: string, claimId: string) {
    if (c.identityPool !== 'workforce' || c.environment !== 'synthetic-staging' || c.dataClassification !== 'synthetic_only'
      || c.containsPhi !== false || c.realPatientData !== false) throw new ProgramMediaError('access_refused');
    return [uuid.parse(c.organizationId), uuid.parse(c.actorPersonId), uuid.parse(artifactId), uuid.parse(claimId)];
  }
  const boolean = async (sql: string, args: unknown[]) => {
    try {
      return await database.transaction(async tx => {
        const answer = await tx.query<{ admitted: boolean }>(sql, args);
        if (answer.rows.length !== 1 || typeof answer.rows[0].admitted !== 'boolean') throw new Error('invalid_answer');
        return answer.rows[0].admitted;
      });
    } catch { throw new ProgramMediaError('service_unavailable'); }
  };
  const execute = async (sql: string, args: unknown[]) => {
    try { await database.transaction(async tx => { await tx.query(sql, args); }); }
    catch { throw new ProgramMediaError('service_unavailable'); }
  };
  const port: Pick<ProgramMediaLedger, 'beginWriter' | 'finishWriter' | 'beginCleanup' | 'certifyCleanup'> & {
    commitWork(c: ClinicalRequestContext, artifactId: string, claimId: string, objectVersion: string): Promise<void>;
  } = {
    beginWriter: (c, id, claim, mode) => boolean('select clinical_private.program_media_begin_work($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5) as admitted',
      [...parameters(c, id, claim), z.enum(['admit', 'reconcile']).parse(mode)]),
    finishWriter: (c, id, claim, outcome) => execute('select clinical_private.program_media_finish_work($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)',
      [...parameters(c, id, claim), z.enum(['settled', 'uncertain']).parse(outcome)]),
    beginCleanup: (c, id, claim) => boolean('select clinical_private.program_media_begin_cleanup($1::uuid,$2::uuid,$3::uuid,$4::uuid) as admitted', parameters(c, id, claim)),
    certifyCleanup: (c, id, claim, proof: ProgramMediaAbsenceProof) => execute('select clinical_private.program_media_certify_cleanup($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb)',
      [...parameters(c, id, claim), JSON.stringify(proof)]),
    commitWork: (c, id, claim, version) => execute('select clinical_private.program_media_commit_work($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)',
      [...parameters(c, id, claim), z.string().min(1).max(1024).refine(v => v !== 'null').parse(version)]),
  };
  return Object.freeze(port);
}
