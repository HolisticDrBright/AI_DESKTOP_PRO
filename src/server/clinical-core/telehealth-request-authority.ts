if (typeof window !== 'undefined') throw Error('telehealth-request-authority is server-only');
import { z } from 'zod';
import { assertTelehealthRequestAuthorityRows, TELEHEALTH_REQUEST_AUTHORITY_BODY_SHA256 } from '../../../scripts/telehealth-request-authority-candidate.mjs';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { bindCareConnectionDatabase } from './care-connections-database-binding';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('consumer_appointments') }).strict(),
  z.object({ action: z.literal('workforce_appointments'), patientRecordId: z.uuid().optional() }).strict(),
]);
const contextShape = z.object({ actorPersonId: z.uuid(), organizationId: z.uuid(),
  identityPool: z.enum(['consumer', 'workforce']), identitySubject: z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),
  purpose: z.literal('clinical_data'), environment: z.literal('production-clinical'),
  dataClassification: z.literal('clinical_phi'), productionBound: z.literal(true), containsPhi: z.literal(true), realPatientData: z.literal(true) }).strict();
const responseShape = z.object({ contract: z.literal('telehealth-request-authority-observation/1'),
  observedAt: z.string().datetime({ offset: true }), databaseName: z.literal('clinical_core_qualification'),
  action: z.enum(['consumer_appointments', 'workforce_appointments']), actorPersonId: z.uuid(), organizationId: z.uuid(),
  identityPool: z.enum(['consumer', 'workforce']), identitySubject: z.string(), patientRecordId: z.uuid().nullable(),
  connectionId: z.uuid().nullable(), appointmentsConsent: z.object({ artifactId: z.uuid(), artifactVersion: z.string().min(1).max(160),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/), grantId: z.uuid(), version: z.number().int().positive() }).strict().nullable(),
  migrationLedger: z.array(z.object({ version: z.string(), name: z.string(), sha256: z.string() }).strict()).length(118),
}).strict();
export type TelehealthRequestAuthorityObservation = Readonly<z.infer<typeof responseShape>>;
export class TelehealthRequestAuthorityError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'consent_required' | 'release_required' | 'service_unavailable') {
    super(category); this.name = 'TelehealthRequestAuthorityError';
  }
}

// Compiled exact 117 parent functions, not hashes supplied by a request/env.
const careFunctions = [
  { name: 'clinical_private.guard_care_consent_text', bodySha256: 'b2bcbd9ffd8802ba2e24048cc23fd247be1e65e17487dd4f1fa281375f57a631', apiExecute: false },
  { name: 'clinical_private.serialize_care_consent_release', bodySha256: '57aae684011938eaebfb651b1b300d3f834a848226fa20050fb096ea572395f0', apiExecute: false },
  { name: 'clinical_private.protect_care_consent_artifact', bodySha256: '95e9d2a91fcc0980acef7a65ab6c8184ccc565f4c3679010cf01d1f84209159e', apiExecute: false },
  { name: 'clinical_private.care_connection_actor', bodySha256: '9948892ba79f9848ef66cf9e1cc403a38f55b8735f58b3535c760dfb2c6aed93', apiExecute: false },
  { name: 'clinical_private.care_connection_artifact', bodySha256: '43a73e8721df550e1009816abf62908d2f0b812a05a868f3c44ce6013b5fa802', apiExecute: false },
  { name: 'clinical_core.create_sync_invitation', bodySha256: '2deb8a2a975e463730f17d7066ca7be68042482e9c0d271d2cf95ac796c26fd0', apiExecute: true },
  { name: 'clinical_core.production_care_connection_request', bodySha256: '1a0712788bb5ad19b098bb288eb11df9fcfa9833ba4f1cda808b1585e92366ea', apiExecute: true },
] as const;

/** Blocked qualification-source observation port, NOT an HTTP/write admission.
 * Independently verified identity/credentials/target must come from a future
 * exact candidate factory. This helper neither proves those nor activates PHI.
 * Never use new-sharing consent as a gate on cancellation or retained records.
 * No network/provider work may be placed inside this short DB transaction. */
export function createTelehealthRequestAuthority(database: ClinicalCoreDatabase) {
  const bound = bindCareConnectionDatabase(database, careFunctions);
  return async (context: ProductionClinicalRequestContext, body: unknown): Promise<TelehealthRequestAuthorityObservation> => {
    const parsed = request.safeParse(body);
    if (!parsed.success) throw new TelehealthRequestAuthorityError('request_invalid');
    if (!contextShape.safeParse(context).success || context.identityPool !== (parsed.data.action === 'consumer_appointments' ? 'consumer' : 'workforce'))
      throw new TelehealthRequestAuthorityError('identity_refused');
    try {
      return await bound.transaction(async tx => {
        const metadata = await tx.query<{ valid: boolean }>(`select count(*)=1 and bool_and(
          p.oid=to_regprocedure('clinical_core.production_telehealth_request_authority(jsonb)')
          and p.prorettype='jsonb'::regtype and p.prokind='f' and p.provolatile='v' and p.prosecdef
          and p.prolang=(select oid from pg_language where lanname='plpgsql')
          and not p.proisstrict and not p.proleakproof and p.proconfig=array['search_path=""']::text[]
          and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$1
          and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')
          and p.proowner=(select relowner from pg_class where oid='clinical_core.schema_migrations'::regclass)
          and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            where a.privilege_type='EXECUTE' and a.grantee not in (p.proowner,'clinical_core_api'::regrole::oid))
        ) as valid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='clinical_core' and p.proname='production_telehealth_request_authority'`, [TELEHEALTH_REQUEST_AUTHORITY_BODY_SHA256]);
        if (metadata.rows[0]?.valid !== true) throw new TelehealthRequestAuthorityError('release_required');
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [clinicalUuid(context.actorPersonId),
          clinicalUuid(context.organizationId), context.identityPool, context.identitySubject, context.purpose, context.environment, context.dataClassification]);
        const result = await tx.query<{ data: unknown }>('select clinical_core.production_telehealth_request_authority($1::jsonb) as data', [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        const response = responseShape.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
        if (!response.success) throw new TelehealthRequestAuthorityError('service_unavailable');
        const r = response.data;
        if (r.action !== parsed.data.action || r.actorPersonId !== context.actorPersonId || r.organizationId !== context.organizationId
          || r.identityPool !== context.identityPool || r.identitySubject !== context.identitySubject
          || (r.action === 'consumer_appointments' && (!r.patientRecordId || !r.connectionId || !r.appointmentsConsent))
          || (parsed.data.action === 'workforce_appointments' && (r.patientRecordId !== (parsed.data.patientRecordId ?? null)
            || r.connectionId !== null || r.appointmentsConsent !== null))) throw new TelehealthRequestAuthorityError('identity_refused');
        try { assertTelehealthRequestAuthorityRows(r.migrationLedger); }
        catch { throw new TelehealthRequestAuthorityError('release_required'); }
        return Object.freeze(r);
      });
    } catch (error) {
      if (error instanceof TelehealthRequestAuthorityError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection && ['request_invalid', 'identity_refused', 'consent_required', 'release_required'].includes(error.category))
        throw new TelehealthRequestAuthorityError(error.category as 'request_invalid' | 'identity_refused' | 'consent_required' | 'release_required');
      throw new TelehealthRequestAuthorityError('service_unavailable');
    }
  };
}
