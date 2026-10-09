// Credential-free deployment preflight: real migration SQL, fictional records, no AWS.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const db = new PGlite({ extensions: { pgcrypto } });
const report = { execution: 'local-pglite-release-audit', phiAllowed: false, findings: [] };
try {
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8'));
  for (const entry of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + entry.file, 'utf8'));
  const [org, owner, practitioner, patient, connection, program, version] = Array.from({ length: 7 }, () => randomUUID());
  await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional release audit')", [org]);
  for (const [person, pool] of [[owner, 'consumer'], [practitioner, 'workforce']]) {
    await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [person, 'syn_' + person.replaceAll('-', '')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)', [person, pool, 'audit-' + person]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, practitioner]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_release_audit')", [patient, org]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, owner]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional reviewed program','published',$3)", [program, org, practitioner]);
  // Published source contains no lessons. A request must not borrow its approval
  // to deliver unrelated caller-authored instructions marked released=true.
  await db.query("insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id) values($1,$2,$3,1,'published','{}'::jsonb,$4)", [version, org, program, practitioner]);
  const phases = [{ id: 'phase-a', title: 'Fictional phase', days: 1, transition: 'scheduled', items: [{ id: 'unpublished-a', title: 'Unpublished fictional lesson', kind: 'lesson', instructions: 'Not present in the published version.', released: true }] }];
  const call = (actor, pool, body) => db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [actor, org, pool, 'audit-' + actor, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
    return (await tx.query('select clinical_core.program_assignment_request($1::jsonb) as data', [JSON.stringify(body)])).rows[0].data;
  });
  let assignment;
  try { assignment = await call(practitioner, 'workforce', { action: 'assign', connectionId: connection, programVersionId: version, title: 'Fictional unreviewed guide', phases }); }
  catch { /* Required refusal: source artifact did not contain the requested lesson. */ }
  if (assignment?.enrollmentId) {
    const read = await call(owner, 'consumer', { action: 'read', enrollmentId: assignment.enrollmentId });
    if (read.review.add.includes('unpublished-a')) report.findings.push({ id: 'PROGRAM_SOURCE_NOT_BOUND', severity: 'deployment-blocker', assignmentAccepted: true, unpublishedLessonAvailableToConsumer: true });
  }
  for (const field of ['days', 'items']) {
    const invalid = structuredClone(phases); delete invalid[0][field];
    const accepted = (await db.query('select clinical_private.program_content_valid($1::jsonb) as valid', [JSON.stringify(invalid)])).rows[0].valid;
    if (accepted) report.findings.push({ id: 'PROGRAM_SQL_REQUIRED_FIELD_MISSING', field, severity: 'database-contract-gap', invalidContentAccepted: true });
  }
  report.verdict = report.findings.length ? 'blocked' : 'pass';
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.findings.length ? 1 : 0;
} finally { await db.close(); }
