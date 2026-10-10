import { execFileSync } from 'node:child_process';
import { CLINIC_RECORD_PRIVACY_SQL_SHA256 } from './clinic-record-privacy-candidate.mjs';

/**
 * The synthetic qualification contract for the clinic-record routes: the exact
 * target binding Codex must execute against, the mandatory positive and
 * negative hosted cases, and the report shape this script checks. It performs
 * no AWS call and no database read. A case that was skipped, refused by the
 * harness, unconfigured or simply not observed never contributes; the only
 * verdict this script can return says the mandatory cases matched, which is not
 * acceptance, not a human review and not permission to enable PHI.
 */
export class ClinicRecordsQualificationError extends Error { constructor(category) { super(category); this.category = category; } }
const refuse = category => { throw new ClinicRecordsQualificationError(category); };
const hash = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export const CLINIC_RECORDS_QUALIFICATION_TARGET = Object.freeze({ account: '588966314750', region: 'us-east-2', database: 'clinical_core_qualification',
  migrationCount: 114, extensionSha256: CLINIC_RECORD_PRIVACY_SQL_SHA256 });
export const CLINIC_RECORDS_QUALIFICATION_ROUTES = Object.freeze(['POST /clinical-core/consumer/clinic-records', 'POST /clinical-core/workforce/clinic-records']);
/** Fictional identities only. Every subject is a distinct qualification-pool user; the two "other clinic" subjects belong to a second fictional organization. */
export const CLINIC_RECORDS_QUALIFICATION_SUBJECTS = Object.freeze(['patientA', 'patientB', 'patientRevoked', 'patientOtherClinic',
  'practitioner', 'staffWithoutClinicalRole', 'practitionerOtherClinic']);
const REVIEWS = Object.freeze(['disclosure', 'retention', 'workforceMfa', 'qualification']);
const READABLE = Object.freeze(['signed_notes', 'telehealth_visits', 'lab_observations']);

const c = (id, phase, pool, subject, action, expect, attest = []) => Object.freeze({ id, phase, pool, subject, action, expect: Object.freeze(expect), attest: Object.freeze(attest) });
/**
 * Mandatory cases, in execution order. `before_release` runs with NO row in
 * clinical_private.clinic_disclosure_releases; `under_release` runs after the
 * owner-reviewed operator inserts the plainly fictional release named in the
 * binding, on the qualification database only. `summary` keys are the exact
 * response fields the runner must copy; `attest` names facts the runner must
 * establish by its own read-only database readback and report as `true`.
 */
export const CLINIC_RECORDS_QUALIFICATION_CASES = Object.freeze([
  c('consumer_stale_signin_refused', 'before_release', 'consumer', 'patientA', 'submit_copy', { status: 401, error: 'reauth_required' }),
  c('consumer_revoked_link_refused', 'before_release', 'consumer', 'patientRevoked', 'submit_copy', { status: 403, error: 'connection_required' }),
  c('consumer_other_clinic_identity_refused', 'before_release', 'consumer', 'patientOtherClinic', 'overview', { status: 403, error: 'identity_refused' }),
  c('workforce_other_clinic_identity_refused', 'before_release', 'workforce', 'practitionerOtherClinic', 'queue', { status: 403, error: 'identity_refused' }),
  c('workforce_without_clinical_role_refused', 'before_release', 'workforce', 'staffWithoutClinicalRole', 'queue', { status: 403, error: 'identity_refused' }),
  c('workforce_malformed_body_refused', 'before_release', 'workforce', 'practitioner', 'queue', { status: 400, error: 'request_invalid' }),
  c('consumer_submit_copy', 'before_release', 'consumer', 'patientA', 'submit_copy', { status: 200, summary: { alreadyApplied: false, status: 'submitted' } }),
  c('consumer_submit_copy_replay', 'before_release', 'consumer', 'patientA', 'submit_copy', { status: 200, summary: { alreadyApplied: true } }, ['singleRequestRow']),
  c('consumer_submit_copy_same_id_other_bytes_refused', 'before_release', 'consumer', 'patientA', 'submit_copy', { status: 409, error: 'conflict' }),
  c('consumer_same_clinic_other_patient_get_refused', 'before_release', 'consumer', 'patientB', 'get', { status: 404, error: 'not_found' }),
  c('workforce_queue_lists_request', 'before_release', 'workforce', 'practitioner', 'queue', { status: 200, summary: { containsRequest: true } }),
  c('workforce_review_counts_only', 'before_release', 'workforce', 'practitioner', 'review', { status: 200, summary: { release: null } }, ['noRecordTextInReview']),
  c('workforce_begin_review', 'before_release', 'workforce', 'practitioner', 'begin_review', { status: 200, summary: { alreadyApplied: false, status: 'in_review' } }),
  c('workforce_begin_review_replay', 'before_release', 'workforce', 'practitioner', 'begin_review', { status: 200, summary: { alreadyApplied: true } }, ['singleReviewStartedEvent']),
  c('workforce_stale_revision_refused', 'before_release', 'workforce', 'practitioner', 'refuse', { status: 409, error: 'conflict' }, ['requestStillInReview']),
  c('workforce_fulfill_without_release_refused', 'before_release', 'workforce', 'practitioner', 'fulfill', { status: 409, error: 'disclosure_release_required' }, ['requestStillInReview', 'noCopyRow']),
  c('consumer_read_copy_unfulfilled_refused', 'before_release', 'consumer', 'patientA', 'read_copy', { status: 404, error: 'not_found' }),
  c('workforce_fulfill_under_fictional_release', 'under_release', 'workforce', 'practitioner', 'fulfill', { status: 200, summary: { alreadyApplied: false, status: 'fulfilled' } },
    ['manifestCompleteClinicRecordFalse', 'everyRequestedSectionIncludedOrExcludedWithReason', 'noDraftOrUnreviewedRowDisclosed']),
  c('workforce_fulfill_replay', 'under_release', 'workforce', 'practitioner', 'fulfill', { status: 200, summary: { alreadyApplied: true } }, ['singleCopyRow']),
  c('consumer_get_second_device', 'under_release', 'consumer', 'patientA', 'get', { status: 200, summary: { status: 'fulfilled', hasCopy: true } }),
  c('consumer_read_copy_fresh_signin', 'under_release', 'consumer', 'patientA', 'read_copy', { status: 200 },
    ['itemDigestsVerifiedAgainstDeviceCanonicalForm', 'noAdmissionOrSigningMaterial', 'noOtherPatientRows', 'copyReadAudited']),
  c('consumer_read_copy_stale_signin_refused', 'under_release', 'consumer', 'patientA', 'read_copy', { status: 401, error: 'reauth_required' }),
  c('consumer_other_patient_read_copy_refused', 'under_release', 'consumer', 'patientB', 'read_copy', { status: 404, error: 'not_found' }),
  c('consumer_withdraw_settled_refused', 'under_release', 'consumer', 'patientA', 'withdraw', { status: 409, error: 'conflict' }),
  c('consumer_submit_correction_disclosed_revision', 'under_release', 'consumer', 'patientA', 'submit_correction', { status: 200, summary: { alreadyApplied: false, status: 'submitted' } }),
  c('consumer_submit_correction_undisclosed_revision_refused', 'under_release', 'consumer', 'patientA', 'submit_correction', { status: 403, error: 'identity_refused' }),
  c('workforce_amend_addendum', 'under_release', 'workforce', 'practitioner', 'amend', { status: 200, summary: { alreadyApplied: false, status: 'fulfilled' } },
    ['originalNoteContentSignatureRevisionUnchanged', 'addendumAttributedToPractitioner']),
  c('workforce_amend_replay', 'under_release', 'workforce', 'practitioner', 'amend', { status: 200, summary: { alreadyApplied: true } }, ['singleAddendum']),
  c('workforce_decline_settled_refused', 'under_release', 'workforce', 'practitioner', 'decline', { status: 409, error: 'conflict' }),
  c('database_ledgers_readback', 'under_release', 'database', 'practitioner', 'readback', { status: null },
    ['apiRoleHasNoTableAccess', 'eventsAndCopiesAppendOnly', 'auditActionsRecorded', 'noRowsForOtherClinic']),
]);

export function assertClinicRecordsQualificationBinding(binding, candidate) {
  const t = CLINIC_RECORDS_QUALIFICATION_TARGET;
  if (!record(candidate) || candidate.contract !== 'clinic-record-privacy-candidate/1' || candidate.migrationCount !== t.migrationCount
    || candidate.extensionSha256 !== t.extensionSha256 || !hash.test(candidate.migrationReleaseSha256 ?? '') || candidate.activation !== 'blocked'
    || candidate.phiAllowed !== false || candidate.deployment !== 'not_deployed' || candidate.seededDisclosureReleases !== false
    || candidate.seededRequests !== false) refuse('candidate_refused');
  const keys = ['contract', 'sourceCommit', 'migrationReleaseSha256', 'extensionSha256', 'apiId', 'organizationId', 'otherOrganizationId',
    'consumerIssuer', 'consumerAudience', 'workforceIssuer', 'workforceAudience', 'subjects', 'reviews', 'disclosureRelease'];
  if (!record(binding) || Object.keys(binding).length !== keys.length || keys.some(k => !Object.hasOwn(binding, k))
    || binding.contract !== 'clinic-records-qualification-binding/1' || !commit.test(binding.sourceCommit ?? '')
    || binding.migrationReleaseSha256 !== candidate.migrationReleaseSha256 || binding.extensionSha256 !== t.extensionSha256
    || !/^[a-z0-9]{10}$/.test(binding.apiId ?? '') || !uuid.test(binding.organizationId ?? '') || !uuid.test(binding.otherOrganizationId ?? '')
    || binding.organizationId === binding.otherOrganizationId) refuse('binding_refused');
  for (const pool of ['consumer', 'workforce']) {
    if (!/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/.test(binding[pool + 'Issuer'] ?? '')
      || !/^[a-zA-Z0-9]{20,128}$/.test(binding[pool + 'Audience'] ?? '')) refuse('binding_refused');
  }
  if (binding.consumerIssuer === binding.workforceIssuer || binding.consumerAudience === binding.workforceAudience) refuse('binding_refused');
  const s = binding.subjects;
  if (!record(s) || Object.keys(s).length !== CLINIC_RECORDS_QUALIFICATION_SUBJECTS.length
    || CLINIC_RECORDS_QUALIFICATION_SUBJECTS.some(k => !uuid.test(s[k] ?? '')) || new Set(Object.values(s)).size !== CLINIC_RECORDS_QUALIFICATION_SUBJECTS.length) refuse('subjects_refused');
  const r = binding.reviews;
  if (!record(r) || Object.keys(r).length !== REVIEWS.length || REVIEWS.some(k => !hash.test(r[k] ?? '') || /^0+$/.test(r[k]))) refuse('review_binding_refused');
  const d = binding.disclosureRelease;
  // A qualification release is plainly fictional by name; its review hash is the disclosure review, never a fabricated digest.
  if (!record(d) || Object.keys(d).length !== 3 || !/^fictional-[A-Za-z0-9._-]{3,69}$/.test(d.releaseVersion ?? '')
    || !Array.isArray(d.sections) || !d.sections.length || d.sections.some(x => !READABLE.includes(x)) || new Set(d.sections).size !== d.sections.length
    || d.reviewSha256 !== r.disclosure) refuse('release_binding_refused');
  // Hash syntax and exact equality never claim a human review actually occurred.
  return binding;
}

function sameSummary(expected, actual) {
  if (expected === undefined) return actual === null || record(actual);
  if (!record(actual)) return false;
  return Object.keys(expected).every(k => Object.hasOwn(actual, k) && JSON.stringify(actual[k]) === JSON.stringify(expected[k]));
}
/**
 * Checks a runner's report against the binding and the mandatory cases. Every
 * case must be present exactly once, actually observed, with the exact status
 * and decided error word, the required summary fields and every attestation
 * true. The result never says accepted: hosted acceptance, device journeys,
 * human review and PHI remain outside this script.
 */
export function evaluateClinicRecordsQualificationReport(report, binding, candidate) {
  const b = assertClinicRecordsQualificationBinding(binding, candidate), t = CLINIC_RECORDS_QUALIFICATION_TARGET;
  if (!record(report) || report.contract !== 'clinic-records-qualification-report/1' || JSON.stringify(report.binding) !== JSON.stringify(b)
    || !when.test(report.startedAt ?? '') || !when.test(report.finishedAt ?? '') || report.finishedAt < report.startedAt
    || report.mutationsOutsideQualificationDatabase !== false || report.phiAllowed !== false) refuse('report_refused');
  const g = report.target;
  if (!record(g) || g.account !== t.account || g.region !== t.region || g.database !== t.database || g.apiId !== b.apiId
    || g.migrationRows !== t.migrationCount || g.migrationReleaseSha256 !== b.migrationReleaseSha256
    || JSON.stringify(g.routes) !== JSON.stringify(CLINIC_RECORDS_QUALIFICATION_ROUTES)) refuse('target_refused');
  const rel = report.releaseRegistered;
  if (rel !== null && (!record(rel) || JSON.stringify(rel) !== JSON.stringify(b.disclosureRelease))) refuse('release_refused');
  if (!Array.isArray(report.cases)) refuse('report_refused');
  const seen = new Map();
  for (const row of report.cases) { if (!record(row) || typeof row.id !== 'string' || seen.has(row.id)) refuse('case_duplicate'); seen.set(row.id, row); }
  const extra = [...seen.keys()].filter(id => !CLINIC_RECORDS_QUALIFICATION_CASES.some(x => x.id === id));
  if (extra.length) refuse('case_unknown');
  let last = report.startedAt;
  for (const spec of CLINIC_RECORDS_QUALIFICATION_CASES) {
    const row = seen.get(spec.id);
    if (!row) refuse('case_missing');
    if (row.observed !== true || row.skipped === true || !when.test(row.at ?? '') || row.at < last || row.at > report.finishedAt) refuse('case_unobserved');
    last = row.at;
    if (spec.phase === 'under_release' && rel === null) refuse('release_required');
    if ((spec.phase === 'before_release' && row.releasePresent !== false) || (spec.phase === 'under_release' && row.releasePresent !== true)) refuse('phase_refused');
    if (row.pool !== spec.pool || row.subject !== spec.subject || row.action !== spec.action
      || row.subjectId !== (spec.pool === 'database' ? null : b.subjects[spec.subject])) refuse('case_binding_refused');
    if (row.status !== spec.expect.status || (row.error ?? null) !== (spec.expect.error ?? null)) refuse('case_mismatch');
    if (spec.expect.status === 200 && !sameSummary(spec.expect.summary, row.summary ?? null)) refuse('case_mismatch');
    if (spec.expect.status !== 200 && spec.expect.status !== null && row.summary !== null && row.summary !== undefined) refuse('case_mismatch');
    const a = row.attestations ?? {};
    if (!record(a) || spec.attest.some(k => a[k] !== true) || Object.keys(a).some(k => !spec.attest.includes(k))) refuse('attestation_missing');
  }
  return Object.freeze({ verdict: 'mandatory_cases_matched', acceptance: false, phiAllowed: false, humanReviewsVerified: false,
    mutations: 'qualification_database_only', cases: CLINIC_RECORDS_QUALIFICATION_CASES.length, sourceCommit: b.sourceCommit,
    migrationReleaseSha256: b.migrationReleaseSha256, releaseVersion: rel?.releaseVersion ?? null,
    remaining: ['owner review of the disclosure release and retention posture', 'hosted concurrency with real interleaving',
      'physical device journeys', 'personal export scope decision', 'PHI activation decision'] });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  if (process.argv.length !== 3 || process.argv[2] !== '--cases') { console.error('usage: node scripts/clinic-records-qualification-report.mjs --cases'); process.exit(2); }
  const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  process.stdout.write(JSON.stringify({ contract: 'clinic-records-qualification-cases/1', target: CLINIC_RECORDS_QUALIFICATION_TARGET,
    candidate: parent.candidate, routes: CLINIC_RECORDS_QUALIFICATION_ROUTES, subjects: CLINIC_RECORDS_QUALIFICATION_SUBJECTS,
    reviews: REVIEWS, cases: CLINIC_RECORDS_QUALIFICATION_CASES }, null, 1) + '\n');
}
