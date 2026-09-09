import { randomUUID } from "node:crypto";
import { clinicalUuid } from "./database";
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
  const person = randomUUID(); const org = randomUUID(); const subject = `acceptance-${randomUUID()}`;
  let verified = false;
  try {
    await database.transaction(async tx => {
      const args = [clinicalUuid(person), clinicalUuid(org), subject];
      await tx.query("set local role clinical_core_api");
      await tx.query("select * from clinical_private.bootstrap_self_service_consumer($1,$2,$3)", args);
      await tx.query("select * from clinical_private.bootstrap_self_service_consumer($1,$2,$3)", args);
      await tx.query("reset role");
      const result = await tx.query<{ count: number }>("select count(*)::int as count from clinical_core.identities where person_id=$1 and identity_subject=$2 and identity_pool='consumer' and production_bound=true and status='active'", [clinicalUuid(person), subject]);
      if (result.rows[0]?.count !== 1) throw new Error("identity_binding_failed");
      await tx.query("set local role clinical_core_api");
      // Exception handled inside PostgreSQL so a denied binding cannot abort the evidence transaction.
      await tx.query(`do $$ begin
        begin
          perform clinical_private.bootstrap_self_service_consumer('${randomUUID()}'::uuid,'${org}'::uuid,'${subject}');
          raise exception 'cross_account_binding_was_allowed';
        exception when insufficient_privilege then null;
        end;
      end $$`);
      verified = true;
      throw new RolledBack();
    });
  } catch (error) { if (!(error instanceof RolledBack)) throw error; }
  const remaining = await database.transaction(async tx => tx.query<{ count: number }>(
    "select ((select count(*) from clinical_core.identities where identity_subject=$1)+(select count(*) from clinical_core.persons where id=$2)+(select count(*) from clinical_core.organizations where id=$3))::int as count",
    [subject, clinicalUuid(person), clinicalUuid(org)],
  ));
  if (!verified || remaining.rows[0]?.count !== 0) throw new Error("rollback_verification_failed");
  console.log(JSON.stringify({ confirmedIdentityBootstrap: true, apiDatabaseRoleVerified: true, duplicateIdempotent: true, conflictingPersonRefused: true, rolledBack: true, retainedFixtureRows: 0, realEmailsUsed: false }));
}
run().catch(() => { console.error("consumer_bootstrap_acceptance_failed"); process.exitCode = 1; });
