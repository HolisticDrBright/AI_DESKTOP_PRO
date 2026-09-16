import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { clinicalUuid, type ClinicalCoreDatabase } from "./database";
import { splitPostgresStatements } from "./migrations";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { createOwnedConsumerApi } from "./owned-consumer-api";
import { createOwnedConsumerRecordsAdapter } from "./owned-consumer-records";
import type { ApiGatewayV2Event } from "./aws-identity-api";

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
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260908100000_production_owned_storage_reads.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260908110000_production_owned_lab_history.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260916010000_production_owned_privacy_export.sql","utf8"))) await tx.query(statement);
      // Fictional approval metadata is exclusively inside this rolled-back transaction.
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) values ('forms_checkins','acceptance-only',encode(public.digest($1,'sha256'),'hex'),$1,'ROLLBACK TEST - NOT A HUMAN APPROVAL',clock_timestamp()),('wearables','acceptance-only',encode(public.digest($1,'sha256'),'hex'),$1,'ROLLBACK TEST - NOT A HUMAN APPROVAL',clock_timestamp())", ["Fictional rollback-only consent copy; not approved for use."]);
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
      stage="api_to_database";
      const issuer="https://cognito-idp.us-east-2.amazonaws.com/rollback"; const audience="12345678901234567890";
      // Real HTTP requests have independent transactions. Preserve that
      // rollback behavior within this one rollback-only fixture transaction.
      let queue:Promise<unknown>=Promise.resolve();
      const apiDatabase:ClinicalCoreDatabase={transaction(work){
        const result=queue.then(async()=>{
          await tx.query('savepoint acceptance_api_request');
          try{const value=await work(tx);await tx.query('release savepoint acceptance_api_request');return value;}
          catch(error){await tx.query('rollback to savepoint acceptance_api_request');await tx.query('release savepoint acceptance_api_request');throw error;}
        });
        queue=result.catch(()=>undefined);return result;
      }};
      const api=createOwnedConsumerApi({configuration:{consumerIssuer:issuer,consumerAudience:audience,phiAllowed:true,activationState:"approved",activationEvidenceSha256:"0".repeat(64),allowedScopes:["forms_checkins","ai_context","lab_history"]},adapter:()=>createOwnedConsumerRecordsAdapter(apiDatabase)});
      const apiEvent=(who:string,subject:string,route:string,query?:Record<string,string>,body?:unknown):ApiGatewayV2Event=>({routeKey:route,queryStringParameters:query,headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),requestContext:{authorizer:{jwt:{claims:{iss:issuer,aud:audience,sub:subject,token_use:"id",email_verified:"true",exp:Math.floor(Date.now()/1000)+600,iat:Math.floor(Date.now()/1000),"custom:person_id":who,"custom:organization_id":org,"custom:production_bound":"true"}}}}});
      const apiId=randomUUID(); const apiRequest=randomUUID();
      const apiBody={collection:"wellness_profiles",recordId:apiId,requestId:apiRequest,expectedRevision:0,consentRevision:3,deleted:false,payload:{id:apiId,goals:[],onboardingCompleted:false,role:"patient"}};
      for (const duplicate of [false,true]) {
        const r=await api(apiEvent(a,subA,"POST /clinical-core/consumer/personal/records",undefined,apiBody));
        if (r.statusCode!==200 || JSON.parse(r.body).data.duplicate!==duplicate) { console.error(JSON.stringify({apiStatus:r.statusCode,code:JSON.parse(r.body).error})); throw new Error("api_write_failed"); } checks++;
      }
      const own=await api(apiEvent(a,subA,"GET /clinical-core/consumer/personal/record",{collection:"wellness_profiles",recordId:apiId}));
      if(own.statusCode!==200 || JSON.parse(own.body).data.payload.id!==apiId) throw new Error("api_read_failed"); checks++;
      const other=await api(apiEvent(b,subB,"GET /clinical-core/consumer/personal/record",{collection:"wellness_profiles",recordId:apiId}));
      if(other.statusCode!==200 || JSON.parse(other.body).data!==null) throw new Error("api_owner_leak"); checks++;
      const consentResponse=await api(apiEvent(a,subA,"GET /clinical-core/consumer/personal/consent",{scope:"forms_checkins"}));
      const consentData=JSON.parse(consentResponse.body).data;
      if(consentResponse.statusCode!==200 || consentData.history.length!==3 || consentData.activeRevision!==3 || !consentData.release.content.includes("Fictional rollback-only")) throw new Error("api_consent_failed"); checks++;
      stage='personal_ai_context';
      const deniedContext=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/chat-context'));
      if(deniedContext.statusCode!==403)throw new Error('ai_consent_not_enforced');checks++;
      await tx.query('reset role');
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) select 'ai_context',version,content_sha256,content,approved_by,approved_at from clinical_private.consumer_storage_consent_releases where scope='forms_checkins'");
      await tx.query('set local role clinical_core_api');
      const aiGrant=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'ai_context',status:'granted',releaseVersion:'acceptance-only',expectedRevision:0}));
      if(aiGrant.statusCode!==200)throw new Error('ai_grant_failed');checks++;
      const aiResult=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/chat-context'));
      const aiData=JSON.parse(aiResult.body).data;
      if(aiResult.statusCode!==200||!aiData.profile||aiData.profile.sex!==null||aiData.labs.length!==0)throw new Error('owned_ai_context_failed');checks++;
      const otherAi=await api(apiEvent(b,subB,'GET /clinical-core/consumer/personal/chat-context'));
      if(otherAi.statusCode!==403)throw new Error('cross_owner_ai_consent_leak');checks++;
      stage='personal_lab_history';
      await tx.query('reset role');
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) select 'lab_history',version,content_sha256,content,approved_by,approved_at from clinical_private.consumer_storage_consent_releases where scope='forms_checkins'");
      await tx.query('set local role clinical_core_api');
      const labId=randomUUID();
      const labBody={collection:'lab_observations',recordId:labId,requestId:randomUUID(),expectedRevision:0,consentRevision:1,deleted:false,payload:{id:labId,panelId:randomUUID(),markerId:randomUUID(),panelName:'Fictional rollback panel',name:'Ferritin',value:0,unit:'ng/mL',drawnAt:'2026-01-01T00:00:00.000Z',reportedRange:{low:1,high:2},sourceStatus:'consumer_import_unverified'}};
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/records',undefined,labBody))).statusCode!==403)throw new Error('lab_consent_missing');checks++;
      for(const [who,subject] of [[a,subA],[b,subB]]){
        if((await api(apiEvent(who,subject,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'lab_history',status:'granted',releaseVersion:'acceptance-only',expectedRevision:0}))).statusCode!==200)throw new Error('lab_grant_failed');checks++;
      }
      for(const duplicate of [false,true]){
        const saved=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/records',undefined,labBody));
        if(saved.statusCode!==200||JSON.parse(saved.body).data.duplicate!==duplicate)throw new Error('lab_write_failed');checks++;
      }
      const labsContext=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/chat-context'));
      const lab=JSON.parse(labsContext.body).data?.labs?.[0];
      if(labsContext.statusCode!==200||lab?.name!=='Ferritin'||lab.value!==0||lab.functionalRange!==null||lab.conventionalRange!==null||lab.sourceStatus!=='consumer_import_unverified')throw new Error('lab_context_failed');checks++;
      const otherLab=await api(apiEvent(b,subB,'GET /clinical-core/consumer/personal/record',{collection:'lab_observations',recordId:labId}));
      if(otherLab.statusCode!==200||JSON.parse(otherLab.body).data!==null)throw new Error('lab_cross_owner_leak');checks++;
      await context(b,subB);await check("select count(*)::int=0 as ok from clinical_core.owned_consumer_record_versions where collection='lab_observations'");
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'lab_history',status:'revoked',expectedRevision:1}))).statusCode!==200)throw new Error('lab_revoke_failed');checks++;
      const withdrawn=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/chat-context'));
      if(withdrawn.statusCode!==200||JSON.parse(withdrawn.body).data.labs.length!==0)throw new Error('lab_withdrawal_leak');checks++;
      stage='privacy_export';
      await context(a,subA);
      for(let i=0;i<3;i++)await tx.query("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,0,$2,jsonb_build_object('historical_fixture',repeat('x',15000)),false,3)",[clinicalUuid(randomUUID()),clinicalUuid(randomUUID())]);
      const exportRequest=randomUUID();
      const startExport=()=>api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/privacy-export',undefined,{requestId:exportRequest}));
      const exportResponse=await startExport(); const manifest=JSON.parse(exportResponse.body).data;
      if(exportResponse.statusCode!==200||manifest.coverage.completeAccountExport!==false||manifest.recordCount<4)throw new Error('privacy_manifest_failed');checks++;
      const replay=await startExport();if(JSON.parse(replay.body).data.exportId!==manifest.exportId)throw new Error('privacy_retry_failed');checks++;
      const throttled=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/privacy-export',undefined,{requestId:randomUUID()}));
      if(throttled.statusCode!==409)throw new Error('privacy_snapshot_limit_failed');checks++;
      const foreign=await api(apiEvent(b,subB,'GET /clinical-core/consumer/personal/privacy-export',{exportId:manifest.exportId,section:'records'}));
      if(foreign.statusCode!==400)throw new Error('privacy_cross_owner_failed');checks++;
      const firstExport=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/privacy-export',{exportId:manifest.exportId,section:'records',limit:'1'}));
      if(firstExport.statusCode!==200||!JSON.parse(firstExport.body).data.nextCursor)throw new Error('privacy_page_failed');checks++;
      const sizeBounded=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/privacy-export',{exportId:manifest.exportId,section:'records',limit:'100'}));
      const sized=JSON.parse(sizeBounded.body).data;
      if(sizeBounded.statusCode!==200||!sized.nextCursor||sized.items.length>=manifest.recordCount||Buffer.byteLength(sizeBounded.body)>32768)throw new Error('privacy_data_api_row_bound_failed');checks++;
      // Later consent/record revisions are not included in this fixed snapshot.
      const later=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/records',undefined,{...apiBody,requestId:randomUUID(),expectedRevision:1,payload:{...apiBody.payload,onboardingCompleted:true}}));
      if(later.statusCode!==200)throw new Error('privacy_concurrent_write_failed');checks++;
      const withdrawnForms=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'forms_checkins',status:'revoked',expectedRevision:3}));
      if(withdrawnForms.statusCode!==200)throw new Error('privacy_withdrawal_failed');checks++;
      for(const section of ['records','consents']){
        let cursor:string|undefined;const rows:Array<Record<string,unknown>>=[];
        do{
          const response=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/privacy-export',{exportId:manifest.exportId,section,limit:'1',...(cursor?{cursor}:{})}));
          const data=JSON.parse(response.body).data;
          if(response.statusCode!==200||data.asOf!==manifest.asOf||rows.length>100)throw new Error('privacy_pagination_failed');
          rows.push(...data.items);cursor=data.nextCursor??undefined;
        }while(cursor);
        if(rows.length!==(section==='records'?manifest.recordCount:manifest.consentCount))throw new Error('privacy_count_failed');checks++;
        if(section==='records'){
          if(!rows.some(r=>r.deleted===true)||!rows.some(r=>r.collection==='lab_observations')||rows.some(r=>r.recordId===apiId&&r.revision===2))throw new Error('privacy_history_failed');checks++;
        }else if(!rows.some(r=>r.status==='revoked')||rows.some(r=>r.scope==='forms_checkins'&&r.revision===4))throw new Error('privacy_consent_snapshot_failed');
      }
      await context(a,subA);
      await refused(`clinical_core.read_owned_privacy_export('${manifest.exportId}','records',1,null)`,'22023');
      await context(a,subA,'consent_management');
      await refused("(select id from clinical_private.owned_privacy_exports limit 1)",'42501');
      await refused(`clinical_core.read_owned_privacy_export('${manifest.exportId}','records',101,null)`,'22023');
      await refused(`clinical_core.read_owned_privacy_export('${manifest.exportId}','records',1,'{"key":"wellness_profiles","revision":1,"recordId":null}'::jsonb)`,'22023');
      await tx.query('reset role');
      await tx.query('update clinical_private.owned_privacy_exports set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[clinicalUuid(manifest.exportId)]);
      await tx.query('set local role clinical_core_api');
      const expired=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/privacy-export',{exportId:manifest.exportId,section:'records'}));
      if(expired.statusCode!==400)throw new Error('privacy_expiry_failed');checks++;
      await context(a,subA);
      await tx.query("select set_config('clinical.claim.identity_pool','workforce',true)");
      await refused("clinical_private.owned_consumer_actor()", "42501");
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) { console.error(JSON.stringify({ failedStage: stage, passedChecks: checks })); throw error; }
  }
  const remaining = await database.transaction(async tx => tx.query<{ ok: boolean }>(
    "select to_regclass('clinical_core.owned_consumer_record_versions') is null and to_regclass('clinical_private.owned_privacy_exports') is null and to_regclass('clinical_audit.owned_privacy_export_events') is null and not exists(select 1 from clinical_core.identities where identity_subject in ($1,$2)) as ok", [subA,subB]));
  if (remaining.rows[0]?.ok !== true) throw new Error("rollback_verification_failed");
  console.log(JSON.stringify({ checks, rollbackVerified: true, retainedSchema: false, retainedFixtureRows: 0, clinicConnectionRequired: false, phiAllowed: false }));
}
run().catch(() => { console.error("owned_consumer_records_acceptance_failed"); process.exitCode = 1; });
