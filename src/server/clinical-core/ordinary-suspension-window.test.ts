import { describe, expect, it, vi } from 'vitest';
import { createAwsProductionIdentityApiHandler, type ApiGatewayV2Event, type ProductionIdentityApiConfiguration } from './aws-identity-api';
import { createAwsProductionClinicalStateAdapter } from './aws-clinical-state';
import { createAwsProductionDesktopAdapter, ProductionDesktopError, type ProductionRequestContext } from './aws-production-desktop';
import type { ClinicalCoreDatabase } from './database';
import { productionDesktopAccess, ORDINARY_SUSPENSION_WINDOW_RELEASE } from './ordinary-suspension-window';

/**
 * Where the BLOCKED ordinary-suspension window's evidence comes from and how it reaches the database. The database rule
 * itself is ordinary-suspension-window.database.test.ts (PGlite) and the two-session native script.
 */
const CLINIC = '22222222-2222-4222-8222-222222222222';
const PERSON = '11111111-1111-4111-8111-111111111111';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce';
const AUDIENCE = 'fictionalworkforceclient000';
const NOW = Math.floor(Date.now() / 1000);

/** A fake database that records every statement and answers with one fictional row. */
function recording() {
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const database: ClinicalCoreDatabase = { transaction: vi.fn(async work => work({ query: async (sql: string, parameters: unknown[] = []) => {
    calls.push({ sql, parameters });
    return { rows: [{ data: [], id: PATIENT }] } as never;
  } })) };
  const entry = () => calls.find(call => call.sql.includes('set_request_context'));
  return { calls, database, entry };
}
const context = (tokenWindow?: { issuedAt: number; expiresAt: number }): ProductionRequestContext => ({
  actorPersonId: PERSON, organizationId: CLINIC, identityPool: 'workforce', identitySubject: 'fictional-subject-0001', purpose: 'clinical_data',
  environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true,
  ...(tokenWindow ? { tokenWindow } : {}),
});
const window = { issuedAt: NOW - 600, expiresAt: NOW + 3000 };

describe('the evidence, from the deployed legacy entry (contextFromClaims) only', () => {
  const configuration: ProductionIdentityApiConfiguration = {
    workforceIssuer: ISSUER, workforceAudience: AUDIENCE,
    consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer', consumerAudience: 'fictionalconsumerclient0000',
    phiAllowed: true, activationState: 'approved', activationEvidenceSha256: 'f'.repeat(64), pilotScope: 'lab_intake_only', pilotOrganizationId: CLINIC,
  };
  const event = (claims: Record<string, string>, headers: Record<string, string> = {}): ApiGatewayV2Event => ({
    routeKey: 'POST /clinical-core/workforce/data-compatibility',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ kind: 'select', table: 'patient_profiles', query: `organization_id=eq.${CLINIC}&id=eq.${PATIENT}` }),
    requestContext: { accountId: '173535830222', authorizer: { jwt: { claims: {
      iss: ISSUER, aud: AUDIENCE, token_use: 'id', sub: 'fictional-subject-0001', 'custom:person_id': PERSON, 'custom:organization_id': CLINIC,
      'custom:production_bound': 'true', ...claims,
    } } } },
  });
  const build = () => {
    const listDesktopPatients = vi.fn(async () => []);
    const handler = createAwsProductionIdentityApiHandler({
      adapter: {} as never, clinicalRecordsAdapter: {} as never, desktopCompatibilityAdapter: { execute: vi.fn() } as never,
      clinicalStateAdapter: { listDesktopPatients } as never, configuration,
    });
    return { handler, listDesktopPatients };
  };

  it('carries the verified token\'s iat and exp on the production context', async () => {
    const { handler, listDesktopPatients } = build();
    const response = await handler(event({ iat: String(window.issuedAt), exp: String(window.expiresAt) }));
    expect(response.statusCode).toBe(200);
    expect(listDesktopPatients).toHaveBeenCalledWith(expect.objectContaining({ tokenWindow: window }), PATIENT);
  });

  it('carries nothing when the claims lack a well-formed pair; a header or body cannot supply one', async () => {
    const { handler, listDesktopPatients } = build();
    await handler(event({}, { 'x-token-iat': String(window.issuedAt), 'x-token-exp': String(window.expiresAt) }));
    await handler(event({ iat: String(window.issuedAt), exp: 'never' }));
    for (const [received] of listDesktopPatients.mock.calls as unknown as Array<[Record<string, unknown>]>) expect(received).not.toHaveProperty('tokenWindow');
  });
});

describe('the production Desktop adapter', () => {
  const select = { kind: 'select' as const, table: 'patient_profiles', query: `organization_id=eq.${CLINIC}` };
  const create = { kind: 'rpc' as const, functionName: 'create_patient_profile', args: { _organization_id: CLINIC, _first_name: 'Fictional',
    _last_name: 'Patient', _date_of_birth: null, _sex: 'unknown', _mrn: null, _email: null, _phone: null } };

  it('ships blocked: the seven-argument entry, exactly as deployed, even with evidence on the context', async () => {
    expect(ORDINARY_SUSPENSION_WINDOW_RELEASE).toBe('blocked');
    const db = recording();
    await createAwsProductionDesktopAdapter(db.database).execute(context(window), select);
    expect(db.entry()!.sql).toBe('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)');
    expect(db.entry()!.parameters).toHaveLength(7);
  });

  it('qualification: the ten-argument entry with the token times and the declared access', async () => {
    const db = recording();
    const adapter = createAwsProductionDesktopAdapter(db.database, undefined, { suspensionWindow: 'qualification' });
    await adapter.execute(context(window), select);
    expect(db.entry()!.sql).toBe('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)');
    expect(db.entry()!.parameters.slice(7)).toEqual([window.issuedAt, window.expiresAt, 'read']);
    db.calls.length = 0;
    await adapter.execute(context(window), create).catch(() => undefined);
    expect(db.entry()!.parameters.slice(7)).toEqual([window.issuedAt, window.expiresAt, 'write']);
  });

  it('qualification without evidence: refused before any transaction', async () => {
    const db = recording();
    const adapter = createAwsProductionDesktopAdapter(db.database, undefined, { suspensionWindow: 'qualification' });
    await expect(adapter.execute(context(), select)).rejects.toEqual(new ProductionDesktopError('identity_refused'));
    expect(db.database.transaction).not.toHaveBeenCalled();
  });

  it('classifies table reads and the listed RPCs as reads, and everything else (an unknown name included) as a write', () => {
    expect(productionDesktopAccess(select)).toBe('read');
    expect(productionDesktopAccess({ kind: 'rpc', functionName: 'list_audit_events', args: {} })).toBe('read');
    for (const name of ['create_patient_profile', 'sign_note', 'record_registered_audit_event', 'get_org_sync_operations', 'not_a_real_rpc']) {
      expect([name, productionDesktopAccess({ kind: 'rpc', functionName: name, args: {} })]).toEqual([name, 'write']);
    }
  });
});

describe('the clinical-state adapter (patient list, lab documents and observations, lab review)', () => {
  it('ships blocked: the seven-argument entry', async () => {
    const db = recording();
    await createAwsProductionClinicalStateAdapter(db.database).listDesktopPatients!(context(window));
    expect(db.entry()!.parameters).toHaveLength(7);
  });

  it('qualification: reads declare read; the lab review declares write; a consumer request is never windowed', async () => {
    const db = recording();
    const adapter = createAwsProductionClinicalStateAdapter(db.database, { suspensionWindow: 'qualification' });
    await adapter.listDesktopPatients!(context(window));
    expect(db.entry()!.parameters.slice(7)).toEqual([window.issuedAt, window.expiresAt, 'read']);
    for (const read of [() => adapter.listDesktopLabDocuments!(context(window), PATIENT), () => adapter.listPatientLabObservations(context(window), PATIENT),
      () => adapter.listLabImports(context(window), 'review_pending')]) {
      db.calls.length = 0;
      await read();
      expect(db.entry()!.parameters.slice(7)).toEqual([window.issuedAt, window.expiresAt, 'read']);
    }
    db.calls.length = 0;
    await adapter.reviewLabResult(context(window), { eventId: PATIENT, decision: 'accept' }).catch(() => undefined);
    expect(db.entry()!.parameters.slice(7)).toEqual([window.issuedAt, window.expiresAt, 'write']);
    db.calls.length = 0;
    await adapter.getConsumerConnection({ ...context(), identityPool: 'consumer' }).catch(() => undefined);
    expect(db.entry()!.parameters).toHaveLength(7);
  });

  it('qualification without evidence: a workforce request is refused before any transaction', async () => {
    const db = recording();
    const adapter = createAwsProductionClinicalStateAdapter(db.database, { suspensionWindow: 'qualification' });
    await expect(adapter.listDesktopPatients!(context())).rejects.toMatchObject({ category: 'clinical_state_refused' });
    expect(db.database.transaction).not.toHaveBeenCalled();
  });
});
