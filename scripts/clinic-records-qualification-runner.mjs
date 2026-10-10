import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CLINIC_RECORDS_QUALIFICATION_CASES as CASES, CLINIC_RECORDS_QUALIFICATION_ROUTES as ROUTES, CLINIC_RECORDS_QUALIFICATION_TARGET as TARGET,
  ClinicRecordsQualificationError, assertClinicRecordsQualificationBinding, evaluateClinicRecordsQualificationReport } from './clinic-records-qualification-report.mjs';

/**
 * Executes the thirty mandatory clinic-record qualification cases against a
 * target through two ports: `http` (the deployed consumer and workforce routes)
 * and `sql` (read-only database readback as a privileged inspection principal).
 * Every observation in the report comes from a real response or a real
 * readback; nothing is supplied as a boolean. A port failure, a token outside
 * its required sign-in window, or a release that is not exactly the bound
 * fictional one ends the run with an incomplete report, which the evaluator
 * refuses. The report never says accepted. Fictional subjects only; tokens are
 * never logged or written.
 *
 * Hosted execution is Codex's lane: `createHostedPorts` binds `fetch` to the
 * qualification API origin and the RDS Data API to the qualification cluster
 * (parameters `$1..$n` are rewritten to the Data API's named form).
 */
export class ClinicRecordsRunnerError extends Error { constructor(category, detail) { super(category); this.category = category; this.detail = detail; } }
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const CONSUMER_WINDOW_MS = 15 * 60_000, COPY_WINDOW_MS = 5 * 60_000;
const SECTIONS = ['signed_notes', 'lab_observations'];

/** Unverified claim read (the gateway verifies signatures); used only to pick a token whose sign-in age fits the case. */
export function tokenClaims(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new ClinicRecordsRunnerError('token_shape');
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { throw new ClinicRecordsRunnerError('token_shape'); }
  if (typeof claims?.sub !== 'string' || !Number.isFinite(Number(claims.auth_time))) throw new ClinicRecordsRunnerError('token_shape');
  return claims;
}
const windows = {
  fresh: age => age <= 4 * 60_000,
  aged: age => age > COPY_WINDOW_MS + 30_000 && age < CONSUMER_WINDOW_MS - 30_000,
  stale: age => age > CONSUMER_WINDOW_MS + 30_000,
};

export async function runClinicRecordsQualification({ binding, candidate, tokens, fixtures, ports, now = () => Date.now(), awaitRelease }) {
  const b = assertClinicRecordsQualificationBinding(binding, candidate);
  if (typeof ports?.http !== 'function' || typeof ports?.sql !== 'function' || typeof awaitRelease !== 'function') throw new ClinicRecordsRunnerError('ports_required');
  if (!fixtures || typeof fixtures.signedNoteText !== 'string' || typeof fixtures.draftNoteText !== 'string' || !fixtures.signedNoteText || !fixtures.draftNoteText) throw new ClinicRecordsRunnerError('fixtures_required');
  const at = () => new Date(now()).toISOString();
  const startedAt = at(), cases = [];
  const state = { requestId: randomUUID(), correctionId: randomUUID(), revision: null, correctionRevision: null, copyId: null,
    noteId: null, noteRevision: null, decision: { begin: randomUUID(), fulfill: randomUUID(), amend: randomUUID() }, patientRecordId: null, before: null };
  const sql = async (text, params = []) => { const r = await ports.sql(text, params); if (!r || !Array.isArray(r.rows)) throw new ClinicRecordsRunnerError('sql_shape'); return r.rows; };
  const token = (subject, kind) => {
    const value = tokens?.[subject]?.[kind];
    if (typeof value !== 'string') throw new ClinicRecordsRunnerError('token_missing', `${subject}.${kind}`);
    const claims = tokenClaims(value);
    if (claims.sub !== b.subjects[subject]) throw new ClinicRecordsRunnerError('token_subject', subject);
    if (!windows[kind](now() - Number(claims.auth_time) * 1000)) throw new ClinicRecordsRunnerError('token_window', `${subject}.${kind}`);
    return value;
  };
  const call = async (pool, subject, body, kind = 'fresh') => {
    const route = ROUTES[pool === 'consumer' ? 0 : 1];
    const r = await ports.http(route, token(subject, kind), typeof body === 'string' ? body : JSON.stringify(body));
    if (!r || !Number.isInteger(r.status)) throw new ClinicRecordsRunnerError('http_shape');
    const json = r.json ?? null;
    return { status: r.status, error: r.status === 200 ? null : (json && typeof json.error === 'string' ? json.error : 'undecided'), data: r.status === 200 && json ? json.data ?? null : null, text: JSON.stringify(json ?? {}) };
  };
  const releaseRows = async () => sql(`select release_version, sections, review_sha256 from clinical_private.clinic_disclosure_releases where organization_id=$1 and revoked_at is null`, [b.organizationId]);
  const count = async (text, params) => Number((await sql(`select count(*)::int as n from ${text}`, params))[0]?.n);
  const outcome = async (spec, work) => {
    const row = { id: spec.id, observed: false, at: at(), pool: spec.pool, subject: spec.subject, action: spec.action, subjectId: spec.pool === 'database' ? null : b.subjects[spec.subject],
      releasePresent: spec.phase === 'under_release', status: null, error: null, summary: null, attestations: {} };
    cases.push(row);
    try {
      const result = await work();
      Object.assign(row, { observed: true, status: result.status ?? null, error: result.error ?? null, summary: result.status === 200 ? result.summary ?? {} : null, attestations: result.attestations ?? {} });
    } catch (error) {
      row.failure = error instanceof ClinicRecordsRunnerError ? `${error.category}${error.detail ? ':' + error.detail : ''}` : 'port_failure';
      throw error;
    }
  };
  const run = {
    consumer_stale_signin_refused: () => call('consumer', 'patientA', { action: 'submit_copy', requestId: state.requestId, sections: SECTIONS }, 'stale'),
    consumer_revoked_link_refused: () => call('consumer', 'patientRevoked', { action: 'submit_copy', requestId: randomUUID(), sections: SECTIONS }),
    consumer_other_clinic_identity_refused: () => call('consumer', 'patientOtherClinic', { action: 'overview' }),
    workforce_other_clinic_identity_refused: () => call('workforce', 'practitionerOtherClinic', { action: 'queue', limit: 10 }),
    workforce_without_clinical_role_refused: () => call('workforce', 'staffWithoutClinicalRole', { action: 'queue', limit: 10 }),
    workforce_malformed_body_refused: () => call('workforce', 'practitioner', '{"action": "queue", "limit": '),
    consumer_submit_copy: async () => {
      const r = await call('consumer', 'patientA', { action: 'submit_copy', requestId: state.requestId, sections: SECTIONS });
      if (r.data?.request) { state.revision = r.data.request.revision; }
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied, status: r.data?.request?.status, requestId: r.data?.request?.requestId } };
    },
    consumer_submit_copy_replay: async () => {
      const r = await call('consumer', 'patientA', { action: 'submit_copy', requestId: state.requestId, sections: SECTIONS });
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied }, attestations: { singleRequestRow: await count('clinical_core.clinic_record_requests where id=$1', [state.requestId]) === 1 } };
    },
    consumer_submit_copy_same_id_other_bytes_refused: () => call('consumer', 'patientA', { action: 'submit_copy', requestId: state.requestId, sections: ['signed_notes'] }),
    consumer_same_clinic_other_patient_get_refused: () => call('consumer', 'patientB', { action: 'get', requestId: state.requestId }),
    workforce_queue_lists_request: async () => {
      const r = await call('workforce', 'practitioner', { action: 'queue', limit: 100 });
      const match = (r.data?.requests ?? []).find(x => x.requestId === state.requestId);
      if (match) state.patientRecordId = match.patientRecordId;
      return { ...r, summary: { containsRequest: Boolean(match) } };
    },
    workforce_review_counts_only: async () => {
      const r = await call('workforce', 'practitioner', { action: 'review', requestId: state.requestId });
      return { ...r, summary: { release: r.data?.release ?? null }, attestations: { noRecordTextInReview: !r.text.includes(fixtures.signedNoteText) && !r.text.includes(fixtures.draftNoteText) } };
    },
    workforce_begin_review: async () => {
      const r = await call('workforce', 'practitioner', { action: 'begin_review', requestId: state.requestId, expectedRevision: state.revision, decisionId: state.decision.begin });
      if (r.data?.request) state.revision = r.data.request.revision;
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied, status: r.data?.request?.status } };
    },
    workforce_begin_review_replay: async () => {
      const r = await call('workforce', 'practitioner', { action: 'begin_review', requestId: state.requestId, expectedRevision: state.revision - 1, decisionId: state.decision.begin });
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied }, attestations: { singleReviewStartedEvent: await count(`clinical_core.clinic_record_request_events where request_id=$1 and action='review_started'`, [state.requestId]) === 1 } };
    },
    workforce_stale_revision_refused: async () => {
      const r = await call('workforce', 'practitioner', { action: 'refuse', requestId: state.requestId, expectedRevision: state.revision - 1, decisionId: randomUUID(), reasonCode: 'other', reason: 'Fictional stale decision' });
      return { ...r, attestations: { requestStillInReview: await count(`clinical_core.clinic_record_requests where id=$1 and status='in_review'`, [state.requestId]) === 1 } };
    },
    workforce_fulfill_without_release_refused: async () => {
      const r = await call('workforce', 'practitioner', { action: 'fulfill', requestId: state.requestId, expectedRevision: state.revision, decisionId: state.decision.fulfill, sections: SECTIONS });
      return { ...r, attestations: { requestStillInReview: await count(`clinical_core.clinic_record_requests where id=$1 and status='in_review'`, [state.requestId]) === 1,
        noCopyRow: await count('clinical_core.clinic_record_copies where request_id=$1', [state.requestId]) === 0 } };
    },
    consumer_read_copy_unfulfilled_refused: () => call('consumer', 'patientA', { action: 'read_copy', requestId: state.requestId, section: 'signed_notes', limit: 10 }),
    workforce_fulfill_under_fictional_release: async () => {
      const r = await call('workforce', 'practitioner', { action: 'fulfill', requestId: state.requestId, expectedRevision: state.revision, decisionId: state.decision.fulfill, sections: SECTIONS });
      if (r.data?.request) { state.revision = r.data.request.revision; state.copyId = r.data.request.fulfillmentId; }
      const copies = await sql('select id, manifest from clinical_core.clinic_record_copies where request_id=$1', [state.requestId]);
      const manifest = copies.length === 1 ? (typeof copies[0].manifest === 'string' ? JSON.parse(copies[0].manifest) : copies[0].manifest) : null;
      const sections = manifest?.sections ?? [];
      const items = copies.length === 1 ? await sql('select section, record_id, payload_text from clinical_core.clinic_record_copy_items where copy_id=$1', [copies[0].id]) : [];
      const accepted = state.patientRecordId ? await count(`clinical_core.lab_observations where organization_id=$1 and patient_record_id=$2 and review_status='accepted'`, [b.organizationId, state.patientRecordId]) : -1;
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied, status: r.data?.request?.status }, attestations: {
        manifestCompleteClinicRecordFalse: manifest?.coverage?.completeClinicRecord === false,
        everyRequestedSectionIncludedOrExcludedWithReason: SECTIONS.every(s => sections.some(x => x.section === s && (x.included === true || typeof x.exclusionReason === 'string'))),
        noDraftOrUnreviewedRowDisclosed: items.length > 0 && items.every(i => !String(i.payload_text).includes(fixtures.draftNoteText)) && items.filter(i => i.section === 'lab_observations').length === accepted } };
    },
    workforce_fulfill_replay: async () => {
      const r = await call('workforce', 'practitioner', { action: 'fulfill', requestId: state.requestId, expectedRevision: state.revision - 1, decisionId: state.decision.fulfill, sections: SECTIONS });
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied }, attestations: { singleCopyRow: await count('clinical_core.clinic_record_copies where request_id=$1', [state.requestId]) === 1 } };
    },
    consumer_get_second_device: async () => {
      const r = await call('consumer', 'patientA', { action: 'get', requestId: state.requestId });
      return { ...r, summary: { status: r.data?.request?.status, hasCopy: r.data?.copy !== null && r.data?.copy !== undefined } };
    },
    consumer_read_copy_fresh_signin: async () => {
      const r = await call('consumer', 'patientA', { action: 'read_copy', requestId: state.requestId, section: 'signed_notes', limit: 10 });
      const items = r.data?.items ?? [];
      const note = items.find(i => i.recordKind === 'clinical_note');
      if (note) {
        state.noteId = note.recordId; state.noteRevision = note.revision;
        state.before = await sql(`select s.note_version, s.content_sha256, s.signed_at, s.signed_by_person_id, v.content::text as content from clinical_core.note_signatures s
          join clinical_core.clinical_note_versions v on v.note_id=s.note_id and v.version=s.note_version where s.note_id=$1 order by s.note_version`, [note.recordId]);
      }
      const owned = note ? await count('clinical_core.clinical_notes where id=$1 and patient_record_id=$2', [note.recordId, state.patientRecordId]) : 0;
      const lower = r.text.toLowerCase();
      return { ...r, summary: { itemCount: items.length }, attestations: {
        itemDigestsVerifiedAgainstDeviceCanonicalForm: items.length > 0 && items.every(i => typeof i.payloadText === 'string' && sha(i.payloadText) === i.payloadSha256 && Buffer.byteLength(i.payloadText, 'utf8') === i.byteLength),
        noAdmissionOrSigningMaterial: !['admission', 'secret', 'key_id', 'signing_key', 'signature_key', 'private_key'].some(w => lower.includes(w)),
        noOtherPatientRows: items.length > 0 && owned === items.filter(i => i.recordKind === 'clinical_note').length && items.every(i => i.recordKind === 'clinical_note'),
        copyReadAudited: await count(`clinical_audit.events where action='clinic_record.copy_read' and resource_id=$1`, [state.requestId]) >= 1 } };
    },
    consumer_read_copy_stale_signin_refused: () => call('consumer', 'patientA', { action: 'read_copy', requestId: state.requestId, section: 'signed_notes', limit: 10 }, 'aged'),
    consumer_other_patient_read_copy_refused: () => call('consumer', 'patientB', { action: 'read_copy', requestId: state.requestId, section: 'signed_notes', limit: 10 }),
    consumer_withdraw_settled_refused: () => call('consumer', 'patientA', { action: 'withdraw', requestId: state.requestId, expectedRevision: state.revision }),
    consumer_submit_correction_disclosed_revision: async () => {
      const r = await call('consumer', 'patientA', { action: 'submit_correction', requestId: state.correctionId, subjectKind: 'clinical_note', subjectId: state.noteId ?? randomUUID(),
        subjectRevision: state.noteRevision ?? 1, reasonCode: 'not_true_of_me', statement: 'Fictional correction statement from the qualification runner.' });
      if (r.data?.request) state.correctionRevision = r.data.request.revision;
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied, status: r.data?.request?.status } };
    },
    consumer_submit_correction_undisclosed_revision_refused: () => call('consumer', 'patientA', { action: 'submit_correction', requestId: randomUUID(), subjectKind: 'clinical_note', subjectId: state.noteId ?? randomUUID(),
      subjectRevision: (state.noteRevision ?? 1) + 1, reasonCode: 'not_true_of_me', statement: 'Fictional statement against an undisclosed revision.' }),
    workforce_amend_addendum: async () => {
      const r = await call('workforce', 'practitioner', { action: 'amend', requestId: state.correctionId, expectedRevision: state.correctionRevision, decisionId: state.decision.amend,
        addendumReason: 'Fictional qualification addendum reason', addendumContent: 'Fictional qualification addendum content.' });
      if (r.data?.request) state.correctionRevision = r.data.request.revision;
      const after = state.noteId ? await sql(`select s.note_version, s.content_sha256, s.signed_at, s.signed_by_person_id, v.content::text as content from clinical_core.note_signatures s
        join clinical_core.clinical_note_versions v on v.note_id=s.note_id and v.version=s.note_version where s.note_id=$1 order by s.note_version`, [state.noteId]) : [];
      const addenda = state.noteId ? await sql(`select a.author_person_id, i.identity_subject from clinical_core.note_addenda a
        join clinical_core.identities i on i.person_id=a.author_person_id and i.identity_pool='workforce' where a.note_id=$1`, [state.noteId]) : [];
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied, status: r.data?.request?.status }, attestations: {
        originalNoteContentSignatureRevisionUnchanged: state.before !== null && state.before.length > 0 && JSON.stringify(state.before) === JSON.stringify(after),
        addendumAttributedToPractitioner: addenda.length === 1 && addenda[0].identity_subject === b.subjects.practitioner } };
    },
    workforce_amend_replay: async () => {
      const r = await call('workforce', 'practitioner', { action: 'amend', requestId: state.correctionId, expectedRevision: state.correctionRevision - 1, decisionId: state.decision.amend,
        addendumReason: 'Fictional qualification addendum reason', addendumContent: 'Fictional qualification addendum content.' });
      return { ...r, summary: { alreadyApplied: r.data?.alreadyApplied }, attestations: { singleAddendum: state.noteId !== null && await count('clinical_core.note_addenda where note_id=$1', [state.noteId]) === 1 } };
    },
    workforce_decline_settled_refused: () => call('workforce', 'practitioner', { action: 'decline', requestId: state.correctionId, expectedRevision: state.correctionRevision, decisionId: randomUUID(), reasonCode: 'record_accurate', reason: 'Fictional decline after settlement' }),
    database_ledgers_readback: async () => {
      const tables = ['clinical_core.clinic_record_requests', 'clinical_core.clinic_record_request_events', 'clinical_core.clinic_record_copies', 'clinical_core.clinic_record_copy_items', 'clinical_private.clinic_disclosure_releases'];
      const privileges = await sql(`select t as table_name, has_table_privilege('clinical_core_api', t, 'SELECT,INSERT,UPDATE,DELETE') as granted from unnest($1::text[]) t`, [tables]);
      const triggers = await sql(`select count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where not t.tgisinternal and t.tgenabled='O' and t.tgtype=27 and n.nspname||'.'||c.relname = any($1::text[])`, [tables]);
      const audited = await sql(`select action, count(*)::int as n from clinical_audit.events where resource_id in ($1, $2) and action like 'clinic_record.%' group by action`, [state.requestId, state.correctionId]);
      const actions = Object.fromEntries(audited.map(r => [r.action, Number(r.n)]));
      return { status: null, error: null, attestations: {
        apiRoleHasNoTableAccess: privileges.length === tables.length && privileges.every(p => p.granted === false),
        eventsAndCopiesAppendOnly: Number(triggers[0]?.n) === tables.length,
        auditActionsRecorded: ['clinic_record.request_submitted', 'clinic_record.review_started', 'clinic_record.copy_fulfilled', 'clinic_record.copy_read', 'clinic_record.correction_amended'].every(a => (actions[a] ?? 0) >= 1),
        noRowsForOtherClinic: await count('clinical_core.clinic_record_requests where organization_id=$1', [b.otherOrganizationId]) === 0 } };
    },
  };
  let releaseRegistered = null;
  const report = () => ({ contract: 'clinic-records-qualification-report/1', binding: b, startedAt, finishedAt: at(), mutationsOutsideQualificationDatabase: false, phiAllowed: false,
    target: { account: TARGET.account, region: TARGET.region, database: TARGET.database, apiId: b.apiId, migrationRows: TARGET.migrationCount, migrationReleaseSha256: b.migrationReleaseSha256, routes: [...ROUTES] },
    releaseRegistered, cases: structuredClone(cases) });
  try {
    const ledger = await sql('select count(*)::int as n from clinical_core.schema_migrations', []);
    if (Number(ledger[0]?.n) !== TARGET.migrationCount) throw new ClinicRecordsRunnerError('target_ledger', String(ledger[0]?.n));
    if ((await releaseRows()).length) throw new ClinicRecordsRunnerError('release_present_before_phase');
    for (const spec of CASES.filter(c => c.phase === 'before_release')) await outcome(spec, run[spec.id]);
    await awaitRelease();
    const live = await releaseRows();
    const d = b.disclosureRelease;
    if (live.length !== 1 || live[0].release_version !== d.releaseVersion || live[0].review_sha256 !== d.reviewSha256
      || JSON.stringify([...(Array.isArray(live[0].sections) ? live[0].sections : JSON.parse(String(live[0].sections)))].sort()) !== JSON.stringify([...d.sections].sort())) throw new ClinicRecordsRunnerError('release_mismatch');
    releaseRegistered = { releaseVersion: d.releaseVersion, sections: [...d.sections], reviewSha256: d.reviewSha256 };
    for (const spec of CASES.filter(c => c.phase === 'under_release')) await outcome(spec, run[spec.id]);
  } catch (error) {
    const incomplete = report();
    return { report: incomplete, verdict: null, refusal: error instanceof ClinicRecordsRunnerError ? `${error.category}${error.detail ? ':' + error.detail : ''}` : 'port_failure', complete: false };
  }
  const complete = report();
  try { return { report: complete, verdict: evaluateClinicRecordsQualificationReport(complete, b, candidate), refusal: null, complete: true }; }
  catch (error) { return { report: complete, verdict: null, refusal: error instanceof ClinicRecordsQualificationError ? error.category : 'evaluation_failure', complete: true }; }
}

/** Hosted ports: fetch against the bound qualification API; RDS Data API readback under the inspection secret Codex supplies. No retries, no logging of bodies or tokens. */
export async function createHostedPorts({ apiId, clusterArn, secretArn, database, region = 'us-east-2' }) {
  if (!/^[a-z0-9]{10}$/.test(apiId ?? '') || database !== TARGET.database || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(clusterArn ?? '')
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(secretArn ?? '') || region !== 'us-east-2') throw new ClinicRecordsRunnerError('hosted_target_refused');
  const { RDSDataClient, ExecuteStatementCommand } = await import('@aws-sdk/client-rds-data');
  const client = new RDSDataClient({ region });
  const origin = `https://${apiId}.execute-api.${region}.amazonaws.com`;
  return {
    http: async (route, token, body) => {
      const response = await fetch(origin + route.slice('POST '.length), { method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      let json = null; try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json };
    },
    sql: async (text, params) => {
      const parameters = params.map((value, i) => ({ name: `p${i + 1}`, value: Array.isArray(value) ? { stringValue: '{' + value.map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',') + '}' } : { stringValue: String(value) },
        ...(Array.isArray(value) ? {} : /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value)) ? { typeHint: 'UUID' } : {}) }));
      const statement = text.replace(/\$(\d+)(::[a-z\[\]]+)?/g, (_m, n, cast) => `:p${n}${cast ?? ''}`);
      const out = await client.send(new ExecuteStatementCommand({ resourceArn: clusterArn, secretArn, database, sql: statement, parameters, formatRecordsAs: 'JSON' }));
      return { rows: out.formattedRecords ? JSON.parse(out.formattedRecords) : [] };
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([a-z-]+)=(.+)$/.exec(a); if (!m) { console.error('usage: --binding=<json> --tokens=<json> --fixtures=<json> --target=<json> --out=<report.json>'); process.exit(2); } return [m[1], m[2]]; }));
  for (const k of ['binding', 'tokens', 'fixtures', 'target', 'out']) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
  const read = p => JSON.parse(readFileSync(p, 'utf8'));
  const candidate = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 })).candidate;
  const ports = await createHostedPorts(read(args.target));
  const result = await runClinicRecordsQualification({ binding: read(args.binding), candidate, tokens: read(args.tokens), fixtures: read(args.fixtures), ports,
    awaitRelease: async () => { process.stderr.write('Register the bound fictional disclosure release on the qualification database with the owner-reviewed operator, then press Enter.\n'); await new Promise(r => process.stdin.once('data', r)); } });
  writeFileSync(args.out, JSON.stringify({ ...result, report: { ...result.report, binding: { ...result.report.binding } } }, null, 2) + '\n');
  console.log(JSON.stringify({ complete: result.complete, verdict: result.verdict?.verdict ?? null, refusal: result.refusal, acceptance: false, phiAllowed: false }));
  process.exit(result.verdict ? 0 : 1);
}
