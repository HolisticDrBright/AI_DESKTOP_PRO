if (typeof window !== 'undefined') throw new Error('commerce role sessions are server-only');
import type { ClinicalCoreDatabase } from '../../clinical-core/database';
import { createRdsDataCommerceSessionDatabase, type CommerceSessionAuthority, type RdsDataCommandClient } from '../../clinical-core/rds-data-database';

/** SHA-256 of infra/aws-clinical-core/source-candidates/program-commerce-runtime-sessions.sql (BLOCKED successor; parent program-education-progress.sql), held equal to the file by its test. */
export const PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256 = 'd2142ad80fead07f83fa23636434274037c87ebad91fa1ce59988ab973b2c037';

export type CommerceSessions = Readonly<Record<CommerceSessionAuthority, ClinicalCoreDatabase>>;
type SessionTarget = { region: 'us-east-2'; database: { clusterArn: string; databaseName: string; sessions: Record<CommerceSessionAuthority, { secretArn: string; login: string }> } };

/**
 * The four least-privilege interfaces the commerce ledgers take, one per authority, each over its
 * own secret (whose login is that authority's runtime role) and assuming only that authority's
 * role. The API handle serves the request paths (consumer access, claim, curriculum, progress; staff
 * status; checkout admission and webhook intake); the worker settles, processes intake and expires;
 * the delivery handle reads due sealed codes and records attempts; the operator records policy and
 * replacements. Nothing here is proof of hosted isolation: that each secret's login holds exactly
 * one membership is a property of the target database, observed by the hosted tests.
 */
export function commerceSessionsFromTarget(target: SessionTarget, client?: RdsDataCommandClient): CommerceSessions {
  const open = (authority: CommerceSessionAuthority) => createRdsDataCommerceSessionDatabase({
    clusterArn: target.database.clusterArn, secretArn: target.database.sessions[authority].secretArn,
    databaseName: target.database.databaseName, region: target.region,
  }, authority, client);
  return Object.freeze({ api: open('api'), worker: open('worker'), delivery: open('delivery'), operator: open('operator') });
}
