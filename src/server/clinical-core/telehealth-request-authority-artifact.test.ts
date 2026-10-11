import { beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertSuccessorQualificationRows } from '../../../scripts/successor-qualification-release.mjs';
import { assertTelehealthRequestAuthorityRows, telehealthRequestAuthorityCandidate, TELEHEALTH_REQUEST_AUTHORITY_FILE,
  TELEHEALTH_REQUEST_AUTHORITY_BODY_SHA256 } from '../../../scripts/telehealth-request-authority-candidate.mjs';
import { createTelehealthRequestAuthority } from './telehealth-request-authority';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import type { ClinicalCoreDatabase } from './database';
import { classifyDatabaseRejection } from './rds-data-database';
type Artifact = { manifest: { contract_version: string; migrations: { version: string; file: string }[] }; files: Record<string, string>;
  candidate: Record<string, unknown>; releaseHash: string };
let parent: Artifact;
const source = readFileSync('infra/aws-clinical-core/source-candidates/telehealth-request-authority.sql', 'utf8').replace(/\r\n?/g, '\n');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(() => { parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })); }, 60000);
const rows = (a: Artifact) => a.manifest.migrations.map(r => ({ version: r.version, name: r.file.slice(15, -4), sha256: sha(a.files[r.file]) }));

it('adds one source-only receipt/function while preserving every parent byte and activation refusal', () => {
  const a = telehealthRequestAuthorityCandidate(parent, source);
  expect(a.manifest.migrations.slice(0, 117)).toEqual(parent.manifest.migrations);
  for (const [file, sql] of Object.entries(parent.files)) expect(a.files[file]).toBe(sql);
  expect(a.manifest.migrations).toHaveLength(118);
  expect(a.candidate).toMatchObject({ migrationCount: 118, parentMigrationCount: 117, deployment: 'not_deployed', activation: 'blocked',
    phiAllowed: false, seededApprovals: false, seededConsents: false, seededIdentities: false, managedRoleSemanticsVerified: false, runtimeAdmission: false });
  expect(a.candidate.extensionSha256).toBe(sha(source));
  expect(sha(/as \$\$([^]*?)\$\$;/.exec(source)![1])).toBe(TELEHEALTH_REQUEST_AUTHORITY_BODY_SHA256);
  expect(source).not.toMatch(/create table|insert into|update clinical_core|delete from clinical_core/i);
  expect(assertTelehealthRequestAuthorityRows(rows(a))).toHaveLength(118);
  expect(() => assertSuccessorQualificationRows(rows(a))).toThrow();
});
it('builder emits exactly the same distinct 118 assembly', () => {
  const actual = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-request-authority-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  expect(actual).toEqual(telehealthRequestAuthorityCandidate(parent, source));
});
it.each(['missing_parent', 'changed_bytes', 'changed_name', 'superset', 'activation', 'phi', 'own_source', 'body_digest'])('refuses %s before constructing an admitted candidate', fault => {
  const a = structuredClone(parent);
  let sql = source;
  if (fault === 'missing_parent') a.manifest.migrations.pop();
  if (fault === 'changed_bytes') a.files[a.manifest.migrations[1].file] += '\n';
  if (fault === 'changed_name') a.manifest.migrations[0].file = '20260812000000_unrelated.sql';
  if (fault === 'superset') a.manifest.migrations.push({ version: '20261011050000', file: '20261011050000_unrelated.sql' });
  if (fault === 'activation') a.candidate.activation = 'approved';
  if (fault === 'phi') a.candidate.phiAllowed = true;
  if (fault === 'own_source') sql += '\n';
  if (fault === 'body_digest') sql = sql.replace('return jsonb_build_object', 'return  jsonb_build_object');
  expect(() => telehealthRequestAuthorityCandidate(a, sql)).toThrow('telehealth_request_authority_artifact_refused');
});
it('normalizes Windows source newlines only, not changed values', () => {
  expect(telehealthRequestAuthorityCandidate(parent, source.replaceAll('\n', '\r\n'))).toEqual(telehealthRequestAuthorityCandidate(parent, source));
});
it.each(['missing', 'duplicate', 'reorder', 'extra', 'own_name', 'own_hash', 'extra_key'])('refuses %s observed ledger', fault => {
  const a = telehealthRequestAuthorityCandidate(parent, source), r = rows(a);
  if (fault === 'missing') r.pop();
  if (fault === 'duplicate') r[4] = { ...r[3] };
  if (fault === 'reorder') [r[1], r[2]] = [r[2], r[1]];
  if (fault === 'extra') r.push({ version: '20261011190000', name: 'extra', sha256: '1'.repeat(64) });
  if (fault === 'own_name') r[117].name = 'unrelated';
  if (fault === 'own_hash') r[117].sha256 = '1'.repeat(64);
  if (fault === 'extra_key') Object.assign(r[117], { approved: true });
  expect(() => assertTelehealthRequestAuthorityRows(r)).toThrow();
  expect(a.files[TELEHEALTH_REQUEST_AUTHORITY_FILE]).toBe(source);
});
it.each(['context', 'pool', 'purpose', 'phi_flag', 'body_actor', 'empty_subject'])('refuses %s before opening a DB transaction', async fault => {
  const c: ProductionClinicalRequestContext = { actorPersonId: '00000000-0000-4000-8000-000000000001', organizationId: '00000000-0000-4000-8000-000000000002',
    identityPool: 'consumer', identitySubject: 'fictional-consumer', purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi',
    containsPhi: true, realPatientData: true, productionBound: true };
  let body: unknown = { action: 'consumer_appointments' };
  if (fault === 'context') c.actorPersonId = 'invalid';
  if (fault === 'pool') c.identityPool = 'workforce';
  if (fault === 'purpose') c.purpose = 'identity_link';
  if (fault === 'phi_flag') Object.assign(c, { containsPhi: false });
  if (fault === 'body_actor') body = { action: 'consumer_appointments', actorPersonId: c.actorPersonId };
  if (fault === 'empty_subject') c.identitySubject = '';
  const db = { transaction: vi.fn() } as ClinicalCoreDatabase;
  await expect(createTelehealthRequestAuthority(db)(c, body)).rejects.toMatchObject({
    category: fault === 'body_actor' ? 'request_invalid' : 'identity_refused',
  });
  expect(db.transaction).not.toHaveBeenCalled();
});
it.each([
  ['telehealth_request_identity_refused', 'identity_refused'], ['telehealth_request_consent_required', 'consent_required'],
  ['telehealth_request_invalid', 'request_invalid'], ['telehealth_request_release_refused', 'release_required'],
])('maps %s without exposing provider or SQL details', (marker, category) => {
  const result = classifyDatabaseRejection({ name: 'DatabaseErrorException', message: 'Database refused: ' + marker + '; private detail' });
  expect(result).toMatchObject({ category, message: category });
  expect(classifyDatabaseRejection({ name: 'untrusted', message: marker })).toBeUndefined();
});
