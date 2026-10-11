import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { CLINIC_RECORDS_QUALIFICATION_CASES as CASES, CLINIC_RECORDS_QUALIFICATION_ROUTES, CLINIC_RECORDS_QUALIFICATION_SUBJECTS,
  CLINIC_RECORDS_QUALIFICATION_TARGET as T, ClinicRecordsQualificationError, assertClinicRecordsQualificationBinding,
  evaluateClinicRecordsQualificationReport } from './clinic-records-qualification-report.mjs';

// Fictional binding and report only. No AWS credentials, no database, no provider request.
const { candidate } = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const hash = 'a'.repeat(64), uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subjects = Object.fromEntries(CLINIC_RECORDS_QUALIFICATION_SUBJECTS.map((k, i) => [k, uuid(10 + i)]));
const binding = () => ({ contract: 'clinic-records-qualification-binding/1', sourceCommit: '1'.repeat(40),
  migrationReleaseSha256: candidate.migrationReleaseSha256, extensionSha256: candidate.extensionSha256, apiId: 'abcdefghij',
  organizationId: uuid(1), otherOrganizationId: uuid(2),
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_fictionalC', consumerAudience: 'c'.repeat(26),
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_fictionalW', workforceAudience: 'w'.repeat(26),
  subjects: { ...subjects }, reviews: { disclosure: hash, retention: 'b'.repeat(64), workforceMfa: 'c'.repeat(64), qualification: 'd'.repeat(64) },
  disclosureRelease: { releaseVersion: 'fictional-qualification-1', sections: ['signed_notes', 'lab_observations'], reviewSha256: hash } });
const at = i => new Date(Date.UTC(2026, 9, 11, 0, 0, i)).toISOString();
const row = (spec, i) => ({ id: spec.id, observed: true, at: at(i + 1), pool: spec.pool, subject: spec.subject, action: spec.action,
  subjectId: spec.pool === 'database' ? null : subjects[spec.subject], releasePresent: spec.phase === 'under_release',
  status: spec.expect.status, error: spec.expect.error ?? null,
  summary: spec.expect.status === 200 ? { ...(spec.expect.summary ?? {}), requestId: uuid(99) } : null,
  attestations: Object.fromEntries(spec.attest.map(k => [k, true])) });
const report = (b = binding()) => ({ contract: 'clinic-records-qualification-report/2', binding: b, startedAt: at(0), finishedAt: at(CASES.length + 1),
  mutationsOutsideQualificationDatabase: false, phiAllowed: false,
  evidenceKind: 'embedded', targetObservation: { contract: 'clinic-records-target-observation/1', account: T.account, region: T.region, database: T.database,
    apiId: b.apiId, migrationRows: 116, migrationReleaseSha256: b.migrationReleaseSha256, routes: [...CLINIC_RECORDS_QUALIFICATION_ROUTES],
    sourceCommit: b.sourceCommit, extensionSha256: b.extensionSha256, zipSha256: hash,
    principalArn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional', functionArn: 'arn:aws:lambda:us-east-2:588966314750:function:fictional',
    foundationStackArn: 'arn:aws:cloudformation:us-east-2:588966314750:stack/fictional-foundation/1', candidateStackArn: 'arn:aws:cloudformation:us-east-2:588966314750:stack/fictional-candidate/2',
    phiAllowed: false, activation: 'blocked', qualification: 'enabled', humanReviewsVerified: false, atomicAwsSnapshot: false },
  target: { account: T.account, region: T.region, database: T.database, apiId: b.apiId, migrationRows: 116,
    migrationReleaseSha256: b.migrationReleaseSha256, routes: [...CLINIC_RECORDS_QUALIFICATION_ROUTES] },
  releaseRegistered: { ...b.disclosureRelease }, cases: CASES.map(row) });
const category = fn => { try { fn(); } catch (e) { if (e instanceof ClinicRecordsQualificationError) return e.category; throw e; } return 'accepted'; };

for (const [name, mutate] of [
  ['missing target observation', r => { delete r.targetObservation; }],
  ['missing evidence kind', r => { delete r.evidenceKind; }],
  ['unsupported evidence kind', r => { r.evidenceKind = 'production'; }],
  ['observation source mismatch', r => { r.targetObservation.sourceCommit = 'e'.repeat(40); }],
  ['claimed atomic AWS snapshot', r => { r.targetObservation.atomicAwsSnapshot = true; }],
  ['claimed human approval', r => { r.targetObservation.humanReviewsVerified = true; }],
]) test(`refuses ${name}`, () => { const r = report(); mutate(r); assert.equal(category(() => evaluateClinicRecordsQualificationReport(r, r.binding, candidate)), 'target_observation_refused'); });
test('the old count-only report contract cannot satisfy the new observation contract', () => {
  const r = report(); r.contract = 'clinic-records-qualification-report/1';
  assert.equal(category(() => evaluateClinicRecordsQualificationReport(r, r.binding, candidate)), 'report_refused');
});

test('the mandatory case list is explicit, ordered by phase, and covers both pools, both outcomes and the database readback', () => {
  assert.equal(CASES.length, 30);
  assert.ok(new Set(CASES.map(c => c.id)).size === CASES.length);
  const firstUnder = CASES.findIndex(c => c.phase === 'under_release');
  assert.ok(CASES.slice(firstUnder).every(c => c.phase === 'under_release'));
  for (const pool of ['consumer', 'workforce']) for (const positive of [true, false]) {
    assert.ok(CASES.some(c => c.pool === pool && (c.expect.status === 200) === positive), `${pool} ${positive ? 'positive' : 'negative'}`);
  }
  for (const code of ['reauth_required', 'connection_required', 'identity_refused', 'request_invalid', 'conflict', 'disclosure_release_required', 'not_found']) {
    assert.ok(CASES.some(c => c.expect.error === code), code);
  }
  assert.ok(CASES.some(c => c.pool === 'database' && c.attest.includes('apiRoleHasNoTableAccess')));
  assert.ok(CASES.every(c => CLINIC_RECORDS_QUALIFICATION_SUBJECTS.includes(c.subject)));
});
test('a complete fictional report matches without ever producing acceptance', () => {
  const b = binding();
  assert.deepEqual(assertClinicRecordsQualificationBinding(b, candidate), b);
  const r = evaluateClinicRecordsQualificationReport(report(b), b, candidate);
  assert.equal(r.verdict, 'mandatory_cases_matched'); assert.equal(r.acceptance, false); assert.equal(r.phiAllowed, false);
  assert.equal(r.humanReviewsVerified, false); assert.equal(r.cases, CASES.length); assert.equal(r.releaseVersion, 'fictional-qualification-1');
  assert.ok(!JSON.stringify(r).includes('accepted'));
});
for (const [name, mutate, expected] of [
  ['the wrong candidate', (r, b, c) => { c.migrationCount = 115; }, 'candidate_refused'],
  ['a widened candidate ledger', (r, b) => { b.migrationReleaseSha256 = 'e'.repeat(64); }, 'binding_refused'],
  ['shared consumer and workforce pools', (r, b) => { b.workforceIssuer = b.consumerIssuer; }, 'binding_refused'],
  ['a duplicate subject', (r, b) => { b.subjects.patientB = b.subjects.patientA; }, 'subjects_refused'],
  ['an all-zero review hash', (r, b) => { b.reviews.disclosure = '0'.repeat(64); }, 'review_binding_refused'],
  ['a release that is not plainly fictional', (r, b) => { b.disclosureRelease.releaseVersion = 'clinic-release-1'; }, 'release_binding_refused'],
  ['a release review hash that is not the disclosure review', (r, b) => { b.disclosureRelease.reviewSha256 = 'f'.repeat(64); }, 'release_binding_refused'],
  ['a release of an unreadable section', (r, b) => { b.disclosureRelease.sections = ['correspondence']; }, 'release_binding_refused'],
  ['a report bound to a different binding', r => { r.binding = { ...r.binding, apiId: 'zzzzzzzzzz' }; }, 'report_refused'],
  ['a report allowing PHI', r => { r.phiAllowed = true; }, 'report_refused'],
  ['a mutation outside the qualification database', r => { r.mutationsOutsideQualificationDatabase = true; }, 'report_refused'],
  ['a target at 115 rows', r => { r.target.migrationRows = 115; }, 'target_refused'],
  ['a target in another account', r => { r.target.account = '000000000000'; }, 'target_refused'],
  ['a missing route', r => { r.target.routes = r.target.routes.slice(0, 1); }, 'target_refused'],
  ['a registered release that differs from the binding', r => { r.releaseRegistered.sections = ['signed_notes']; }, 'release_refused'],
  ['an under_release case without any registered release', r => { r.releaseRegistered = null; r.cases.forEach(c => { c.releasePresent = false; }); }, 'release_required'],
  ['a missing case', r => { r.cases = r.cases.filter(c => c.id !== 'consumer_read_copy_fresh_signin'); }, 'case_missing'],
  ['a duplicated case', r => { r.cases.push({ ...r.cases[0] }); }, 'case_duplicate'],
  ['an unknown case', r => { r.cases.push({ ...r.cases[0], id: 'extra_case' }); }, 'case_unknown'],
  ['a skipped case', r => { r.cases[6].skipped = true; }, 'case_unobserved'],
  ['an unobserved case', r => { r.cases[6].observed = false; }, 'case_unobserved'],
  ['a case observed out of order', r => { r.cases[6].at = r.cases[3].at; }, 'case_unobserved'],
  ['a case observed after the report finished', r => { r.cases[CASES.length - 1].at = at(CASES.length + 5); }, 'case_unobserved'],
  ['a before_release case run with a release present', r => { r.cases[15].releasePresent = true; }, 'phase_refused'],
  ['a case executed as the wrong subject', r => { r.cases[9].subjectId = subjects.patientA; }, 'case_binding_refused'],
  ['a refusal reported with a different status', r => { r.cases[15].status = 503; r.cases[15].error = 'service_unavailable'; }, 'case_mismatch'],
  ['a positive case reported as a refusal', r => { r.cases[6].status = 403; r.cases[6].error = 'identity_refused'; r.cases[6].summary = null; }, 'case_mismatch'],
  ['a replay reported as a new row', r => { r.cases[7].summary.alreadyApplied = false; }, 'case_mismatch'],
  ['a refusal carrying a summary', r => { r.cases[0].summary = { status: 'submitted' }; }, 'case_mismatch'],
  ['a missing attestation', r => { delete r.cases[17].attestations.manifestCompleteClinicRecordFalse; }, 'attestation_missing'],
  ['a false attestation', r => { r.cases[26].attestations.originalNoteContentSignatureRevisionUnchanged = false; }, 'attestation_missing'],
  ['an attestation the case does not define', r => { r.cases[0].attestations = { phiApproved: true }; }, 'attestation_missing'],
]) {
  test(`refuses ${name}`, () => {
    const b = binding(), c = structuredClone(candidate), r = report(b);
    mutate(r, b, c);
    assert.equal(category(() => evaluateClinicRecordsQualificationReport(r, b, c)), expected);
  });
}
test('--cases prints the exact candidate identity with the case list and nothing executable', () => {
  const out = JSON.parse(execFileSync(process.execPath, ['scripts/clinic-records-qualification-report.mjs', '--cases'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  assert.equal(out.contract, 'clinic-records-qualification-cases/1');
  assert.deepEqual(out.candidate, candidate); assert.equal(out.cases.length, CASES.length);
  assert.deepEqual(out.routes, [...CLINIC_RECORDS_QUALIFICATION_ROUTES]);
  assert.equal(out.candidate.activation, 'blocked'); assert.equal(out.candidate.phiAllowed, false);
});
