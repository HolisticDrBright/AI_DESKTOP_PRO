import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { clinicalUuid } from "./database";
import { splitPostgresStatements } from "./migrations";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";

class RolledBack extends Error {}
async function run() {
  const env = process.env;
  if (env.PHI_ALLOWED !== "false" || env.CONFIRM_ROLLBACK_ONLY !== "true"
    || env.EXPECTED_AWS_ACCOUNT_ID !== "173535830222"
    || !env.CLINICAL_DATABASE_CLUSTER_ARN?.includes(":173535830222:cluster:")) throw new Error("acceptance_boundary_refused");
  const database = createRdsDataAdministrativeDatabase({ clusterArn: env.CLINICAL_DATABASE_CLUSTER_ARN,
    secretArn: env.CLINICAL_DATABASE_SECRET_ARN ?? "", databaseName: env.CLINICAL_DATABASE_NAME ?? "", region: env.AWS_REGION,
  }, { purpose: "reviewed_production_schema_migration" });
  const sql = readFileSync("infra/aws-clinical-core/production-migrations/20260908090000_production_owned_consumer_records.sql", "utf8");
  const a = randomUUID(); const b = randomUUID(); const org = randomUUID();
  const subA = `acceptance-${randomUUID()}`; const subB = `acceptance-${randomUUID()}`;
  const record = randomUUID(); const request = randomUUID();
  let checks = 0; let stage = "start";
  try {
    await database.transaction(async tx => {
      stage = "migration";
      for (const statement of splitPostgresStatements(sql)) await tx.query(statement);
      // Fictional approval metadata is exclusively inside this rolled-back transaction.
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,approved_by,approved_at) values ('forms_checkins','acceptance-only',$1,'ROLLBACK TEST - NOT A HUMAN APPROVAL',clock_timestamp()),('wearables','acceptance-only',$1,'ROLLBACK TEST - NOT A HUMAN APPROVAL',clock_timestamp())", ["0".repeat(64)]);
      await tx.query("set local role clinical_core_api");
      for (const [person, subject] of [[a, subA], [b, subB]]) {
        await tx.query("select * from clinical_private.bootstrap_self_service_consumer($1,$2,$3)", [clinicalUuid(person),clinicalUuid(org),subject]);
      }
      const context = async (person: string, subject: string, purpose = "clinical_data") => {
        await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,$4,'production-clinical','clinical_phi')", [clinicalUuid(person),clinicalUuid(org),subject,purpose]);
      };
      const check = async (query: string, parameters: readonly unknown[] = []) => {
        const result = await tx.query<{ ok: boolean }>(query, parameters);
        if (result.rows[0]?.ok !== true) throw new Error(`assertion_${checks + 1}`);
        checks++;
      };
      // All dynamic values below are generated UUIDs, never request content.
      const refused = async (expression: string, code: string) => {
        await tx.query(`do $$ begin begin perform ${expression}; raise exception 'expected_denial_missing'; exception when sqlstate '${code}' then null; end; end $$`);
        checks++;
      };
      const write = (body = "{}", expected = 0, req = request, consent = 1) =>
        `clinical_core.write_owned_consumer_record('wellness_profiles','${record}',${expected},'${req}','${body}'::jsonb,false,${consent})`;
      stage = "null_context";
      await refused("clinical_private.owned_consumer_actor()", "42501");
      await context(a,subA,"consent_management");
      stage = "unsigned_release";
      await refused("clinical_core.set_owned_consumer_consent('forms_checkins','granted','unapproved',0)", "42501");
      await check("select (clinical_core.set_owned_consumer_consent('forms_checkins','granted','acceptance-only',0)->>'revision')::int=1 as ok");
      await context(a,subA);
      stage = "write_retry";
      await check(`select (${write()}->>'revision')::int=1 as ok`);
      await check(`select (${write()}->>'duplicate')::boolean as ok`);
      await refused(write('{"different":true}'), "40001");
      await refused(write("{}",0,randomUUID()), "40001");
      stage = "scope_consent";
      await refused(`clinical_core.write_owned_consumer_record('wearable_daily_records','${randomUUID()}',0,'${randomUUID()}','{}',false,1)`, "42501");
      await check("select jsonb_array_length(clinical_core.list_owned_consumer_records('wellness_profiles',10))=1 as ok");
      await check("select count(*)::int=0 as ok from clinical_core.patient_connections where consumer_person_id=$1", [clinicalUuid(a)]);
      stage = "cross_owner";
      await context(b,subB,"consent_management");
      await tx.query("select clinical_core.set_owned_consumer_consent('forms_checkins','granted','acceptance-only',0)");
      await context(b,subB);
      await check("select jsonb_array_length(clinical_core.list_owned_consumer_records('wellness_profiles',10))=0 as ok");
      await check("select count(*)::int=0 as ok from clinical_core.owned_consumer_record_versions where owner_id=$1", [clinicalUuid(a)]);
      await check("select count(*)::int=0 as ok from clinical_core.consumer_storage_consents where owner_id=$1", [clinicalUuid(a)]);
      await check("select count(*)::int=0 as ok from clinical_audit.consumer_storage_events where owner_id=$1", [clinicalUuid(a)]);
      await check("select clinical_private.owned_consumer_consent($1,'forms_checkins') is null as ok", [clinicalUuid(a)]);
      await refused(`clinical_core.write_owned_consumer_record('wellness_profiles','${record}',1,'${randomUUID()}','{}',false,1)`, "40001");
      stage = "revocation";
      await context(a,subA,"consent_management");
      await tx.query("select clinical_core.set_owned_consumer_consent('forms_checkins','revoked',null,1)");
      await context(a,subA);
      await refused(write(), "42501");
      await refused("clinical_core.list_owned_consumer_records('wellness_profiles',10)", "42501");
      await check("select count(*)::int=0 as ok from clinical_core.owned_consumer_record_versions");
      await context(a,subA,"consent_management");
      await tx.query("select clinical_core.set_owned_consumer_consent('forms_checkins','granted','acceptance-only',2)");
      await context(a,subA);
      await refused(write(), "42501");
      stage = "version_and_delete";
      await check(`select (${write('{"changed":true}',1,randomUUID(),3)}->>'revision')::int=2 as ok`);
      await check("select jsonb_array_length(clinical_core.list_owned_consumer_records('wellness_profiles',10))=1 as ok");
      await check("select clinical_core.list_owned_consumer_records('wellness_profiles',10)->0->'payload'->>'changed'='true' as ok");
      await tx.query("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,2,$2,'{}',true,3)", [clinicalUuid(record),clinicalUuid(randomUUID())]);
      await check("select jsonb_array_length(clinical_core.list_owned_consumer_records('wellness_profiles',10))=0 as ok");
      stage = "direct_write_denied";
      await tx.query("do $$ begin begin delete from clinical_core.owned_consumer_record_versions; raise exception 'direct_delete_allowed'; exception when insufficient_privilege then null; end; end $$"); checks++;
      await tx.query("select set_config('clinical.claim.identity_pool','workforce',true)");
      await refused("clinical_private.owned_consumer_actor()", "42501");
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) { console.error(JSON.stringify({ failedStage: stage, passedChecks: checks })); throw error; }
  }
  const remaining = await database.transaction(async tx => tx.query<{ ok: boolean }>(
    "select to_regclass('clinical_core.owned_consumer_record_versions') is null and not exists(select 1 from clinical_core.identities where identity_subject in ($1,$2)) as ok", [subA,subB]));
  if (remaining.rows[0]?.ok !== true) throw new Error("rollback_verification_failed");
  console.log(JSON.stringify({ checks, rollbackVerified: true, retainedSchema: false, retainedFixtureRows: 0, clinicConnectionRequired: false, phiAllowed: false }));
}
run().catch(() => { console.error("owned_consumer_records_acceptance_failed"); process.exitCode = 1; });
