import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { clinicalUuid, type ClinicalCoreDatabase } from "./database";
import { splitPostgresStatements } from "./migrations";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { createOwnedConsumerApi } from "./owned-consumer-api";
import { createOwnedConsumerRecordsAdapter } from "./owned-consumer-records";
import type { ApiGatewayV2Event } from "./aws-identity-api";
import {createOwnedVoiceApi,type OwnedVoiceEvent} from './owned-voice-api';
import type {VoiceAuthorization} from './voice-authorization';
import mealFixture from '@/contracts/personalMealBackup.fixture.json';
import {personalMealBackupSchema} from '@/contracts/personalMealBackup';

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
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260916020000_production_owned_voice_consent.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260916030000_production_owned_active_plan.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260916040000_production_owned_privacy_requests.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260916050000_production_guardian_authority.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260916060000_production_owned_reproductive_context_guard.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260916070000_production_owned_deletion_hold_guard.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260917010000_production_privacy_fulfillment_safety.sql","utf8"))) await tx.query(statement);
      for (const statement of splitPostgresStatements(readFileSync("infra/aws-clinical-core/production-migrations/20260917020000_production_owned_correction_resolution.sql","utf8"))) await tx.query(statement);
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
      const api=createOwnedConsumerApi({configuration:{consumerIssuer:issuer,consumerAudience:audience,phiAllowed:true,activationState:"approved",activationEvidenceSha256:"0".repeat(64),allowedScopes:["forms_checkins","ai_context","lab_history","voice_transcription","protocols_supplements","nutrition"]},adapter:()=>createOwnedConsumerRecordsAdapter(apiDatabase)});
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
      stage='personal_meal_backup';
      const mealId=randomUUID(),mealPayload={...personalMealBackupSchema.parse(mealFixture),id:mealId};
      const mealBody={collection:'meal_logs',recordId:mealId,requestId:randomUUID(),expectedRevision:0,consentRevision:1,deleted:false,payload:mealPayload};
      const mealRoute='POST /clinical-core/consumer/personal/records';
      if((await api(apiEvent(a,subA,mealRoute,undefined,mealBody))).statusCode!==403)throw new Error('meal_missing_consent_allowed');checks++;
      await tx.query('reset role');
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) select 'nutrition',version,content_sha256,content,approved_by,approved_at from clinical_private.consumer_storage_consent_releases where scope='forms_checkins'");
      await tx.query('set local role clinical_core_api');
      for(const [who,subject] of [[a,subA],[b,subB]]){
        if((await api(apiEvent(who,subject,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'nutrition',status:'granted',releaseVersion:'acceptance-only',expectedRevision:0}))).statusCode!==200)throw new Error('meal_consent_failed');checks++;
      }
      for(const duplicate of [false,true]){
        const r=await api(apiEvent(a,subA,mealRoute,undefined,mealBody));
        if(r.statusCode!==200||JSON.parse(r.body).data?.duplicate!==duplicate)throw new Error('meal_write_failed');checks++;
      }
      if((await api(apiEvent(a,subA,mealRoute,undefined,{...mealBody,requestId:randomUUID(),payload:{...mealPayload,sugar_g:999}}))).statusCode!==400)throw new Error('meal_bad_totals_allowed');checks++;
      if((await api(apiEvent(a,subA,mealRoute,undefined,{...mealBody,requestId:randomUUID()}))).statusCode!==409)throw new Error('meal_stale_revision_allowed');checks++;
      const readMeal=(who=a,subject=subA)=>api(apiEvent(who,subject,'GET /clinical-core/consumer/personal/record',{collection:'meal_logs',recordId:mealId}));
      const fullMeal=await readMeal();
      if(fullMeal.statusCode!==200||JSON.stringify(personalMealBackupSchema.parse(JSON.parse(fullMeal.body).data?.payload))!==JSON.stringify(personalMealBackupSchema.parse(mealPayload)))throw new Error('meal_round_trip_failed');checks++;
      const foreignMeal=await readMeal(b,subB);
      if(foreignMeal.statusCode!==200||JSON.parse(foreignMeal.body).data!==null)throw new Error('meal_owner_leak');checks++;
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'nutrition',status:'revoked',expectedRevision:1}))).statusCode!==200)throw new Error('meal_revoke_failed');checks++;
      if((await readMeal()).statusCode!==403)throw new Error('meal_withdraw_read_allowed');checks++;
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'nutrition',status:'granted',releaseVersion:'acceptance-only',expectedRevision:2}))).statusCode!==200)throw new Error('meal_regrant_failed');checks++;
      const removeMealBody={...mealBody,requestId:randomUUID(),expectedRevision:1,consentRevision:3,deleted:true,payload:{}};
      // Fictional hold in the same rolled-back transaction; no workforce identity or real hold is changed.
      await tx.query('reset role');
      const holdId=randomUUID();
      await tx.query("insert into clinical_private.owned_legal_holds(id,owner_id,reason_code,placed_by) values($1,$2,'owner_dispute',$2)",[clinicalUuid(holdId),clinicalUuid(a)]);
      await tx.query('set local role clinical_core_api');
      const heldMeal=await api(apiEvent(a,subA,mealRoute,undefined,removeMealBody));
      if(heldMeal.statusCode!==403||JSON.parse(heldMeal.body).error!=='legal_hold')throw new Error('meal_legal_hold_bypassed');checks++;
      const heldRead=await readMeal();
      if(heldRead.statusCode!==200||JSON.parse(heldRead.body).data?.revision!==1)throw new Error('meal_hold_modified_record');checks++;
      await tx.query('reset role');
      await tx.query("update clinical_private.owned_legal_holds set released_by=$1,released_at=clock_timestamp() where id=$2",[clinicalUuid(a),clinicalUuid(holdId)]);
      await tx.query('set local role clinical_core_api');
      const removedMeal=await api(apiEvent(a,subA,mealRoute,undefined,removeMealBody));
      if(removedMeal.statusCode!==200||JSON.parse(removedMeal.body).data?.revision!==2)throw new Error('meal_tombstone_failed');checks++;
      const tombstone=await readMeal(),tombstoneData=JSON.parse(tombstone.body).data;
      if(tombstone.statusCode!==200||tombstoneData?.deleted!==true||Object.keys(tombstoneData.payload).length!==0)throw new Error('meal_tombstone_read_failed');checks++;
      const remainingMeals=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/records',{collection:'meal_logs',limit:'10'}));
      if(remainingMeals.statusCode!==200||JSON.parse(remainingMeals.body).data?.items.length!==0)throw new Error('meal_deleted_listed');checks++;
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
      stage='reproductive_collection_context';
      await tx.query('reset role');
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) select 'reproductive_health',version,content_sha256,content,approved_by,approved_at from clinical_private.consumer_storage_consent_releases where scope='forms_checkins'");
      await tx.query('set local role clinical_core_api');
      const contextId=randomUUID();
      const withContext={...labBody,recordId:contextId,requestId:randomUUID(),payload:{...labBody.payload,id:contextId,collectionContext:{ageAtDraw:{value:36,unit:'years'},observedOn:'2026-01-01',sex:'female',pregnancyStatus:'not_pregnant',cyclePhase:'luteal',reproductiveStage:'reproductive',contraception:'none',pregnancyTrimester:null,assayId:null}}};
      const recordsRoute='POST /clinical-core/consumer/personal/records';
      if((await api(apiEvent(a,subA,recordsRoute,undefined,withContext))).statusCode!==403)throw new Error('reproductive_missing_consent_allowed');checks++;
      await context(a,subA,'consent_management');
      await tx.query("select clinical_core.set_owned_consumer_consent('reproductive_health','granted','acceptance-only',0)");
      if((await api(apiEvent(a,subA,recordsRoute,undefined,withContext))).statusCode!==200)throw new Error('reproductive_authorized_write_refused');checks++;
      const readContext=()=>api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/record',{collection:'lab_observations',recordId:contextId}));
      let contextResponse=await readContext();
      if(contextResponse.statusCode!==200||!JSON.parse(contextResponse.body).data?.payload?.collectionContext)throw new Error('reproductive_authorized_read_refused');checks++;
      await context(a,subA,'consent_management');
      await tx.query("select clinical_core.set_owned_consumer_consent('reproductive_health','revoked',null,1)");
      contextResponse=await readContext();
      if(contextResponse.statusCode!==200||JSON.parse(contextResponse.body).data?.payload?.collectionContext)throw new Error('reproductive_withdrawal_leak');checks++;
      if((await api(apiEvent(a,subA,recordsRoute,undefined,{...withContext,expectedRevision:1,requestId:randomUUID()}))).statusCode!==403)throw new Error('reproductive_withdrawal_write_allowed');checks++;
      await context(a,subA);
      // Bypass the adapter: the database trigger must independently refuse it.
      await refused(`clinical_core.write_owned_consumer_record('lab_observations','${contextId}',1,'${randomUUID()}','${JSON.stringify(withContext.payload)}'::jsonb,false,1)`,'42501');
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'lab_history',status:'revoked',expectedRevision:1}))).statusCode!==200)throw new Error('lab_revoke_failed');checks++;
      const withdrawn=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/chat-context'));
      if(withdrawn.statusCode!==200||JSON.parse(withdrawn.body).data.labs.length!==0)throw new Error('lab_withdrawal_leak');checks++;
      stage='owned_voice_consent';
      let voiceBinding:{owner:string;authorization?:VoiceAuthorization}|undefined;
      const voiceId='a'.repeat(64);
      // Voice storage/provider and payment are doubles; identity/consent crosses
      // the actual handler/adapter/Data API into this rollback-only Aurora tx.
      const voice=createOwnedVoiceApi({configuration:{consumerIssuer:issuer,consumerAudience:audience,phiAllowed:true,activationState:'approved',
        activationEvidenceSha256:'0'.repeat(64),providerEvidenceSha256:'0'.repeat(64),allowedScopes:['ai_context','voice_transcription']},
        adapter:()=>createOwnedConsumerRecordsAdapter(apiDatabase),requireCore:async()=>{},
        service:policy=>({
          async start(owner,_body,authorization){voiceBinding={owner,authorization};await policy.verify(voiceBinding);return {jobId:voiceId,state:'processing'};},
          async status(owner){if(!voiceBinding||voiceBinding.owner!==owner)throw Object.assign(new Error('missing'),{status:404});await policy.verify(voiceBinding);return {jobId:voiceId,state:'ready',transcript:'Rollback-only fictional transcript.'};},
          async cancel(owner){if(!voiceBinding||voiceBinding.owner!==owner)throw Object.assign(new Error('missing'),{status:404});return {jobId:voiceId,state:'cancelled'};},
          async sweep(){},
        })});
      const voiceEvent=(person:string,subject:string,method='POST'):OwnedVoiceEvent=>{
        const base=apiEvent(person,subject,'');
        return {...base,rawPath:'/clinical-core/consumer/chat-transcription/jobs'+(method==='POST'?'':'/'+voiceId),
          requestContext:{...base.requestContext,http:{method}},...(method==='POST'?{body:JSON.stringify({requestId:randomUUID(),audioBase64:Buffer.alloc(64).toString('base64'),mimeType:'audio/wav',consentVersion:'patient-chat-consent/1',purpose:'patient_chat_voice_input'})}:{})};
      };
      if((await voice(voiceEvent(a,subA))).statusCode!==403)throw new Error('voice_unsigned_consent_allowed');checks++;
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'voice_transcription',status:'granted',releaseVersion:'acceptance-only',expectedRevision:0}))).statusCode!==403)throw new Error('voice_missing_release_allowed');checks++;
      await tx.query('reset role');
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) select 'voice_transcription',version,content_sha256,content,approved_by,approved_at from clinical_private.consumer_storage_consent_releases where scope='forms_checkins'");
      await tx.query('set local role clinical_core_api');
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'voice_transcription',status:'granted',releaseVersion:'acceptance-only',expectedRevision:0}))).statusCode!==200)throw new Error('voice_grant_failed');checks++;
      if((await voice(voiceEvent(a,subA))).statusCode!==202||voiceBinding?.authorization?.personId!==a)throw new Error('voice_owner_binding_failed');checks++;
      if((await voice(voiceEvent(a,subA,'GET'))).statusCode!==200)throw new Error('voice_read_failed');checks++;
      if((await voice(voiceEvent(b,subB,'GET'))).statusCode!==404)throw new Error('voice_other_owner_allowed');checks++;
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'voice_transcription',status:'revoked',expectedRevision:1}))).statusCode!==200)throw new Error('voice_withdraw_failed');checks++;
      if((await voice(voiceEvent(a,subA,'GET'))).statusCode!==403)throw new Error('voice_withdraw_read_allowed');checks++;
      if((await voice(voiceEvent(a,subA,'DELETE'))).statusCode!==202)throw new Error('voice_withdraw_cleanup_denied');checks++;
      if((await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/consent',undefined,{scope:'voice_transcription',status:'granted',releaseVersion:'acceptance-only',expectedRevision:2}))).statusCode!==200)throw new Error('voice_regrant_failed');checks++;
      if((await voice(voiceEvent(a,subA,'GET'))).statusCode!==403)throw new Error('voice_old_recording_revived');checks++;
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
      stage='active_plan';
      // Fictional plans scope release inside the rolled-back transaction only.
      await tx.query('reset role');
      await tx.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content_sha256,content,approved_by,approved_at) values ('protocols_supplements','acceptance-only',encode(public.digest($1,'sha256'),'hex'),$1,'ROLLBACK TEST - NOT A HUMAN APPROVAL',clock_timestamp())",["Fictional rollback-only plans consent copy; not approved for use."]);
      await tx.query('set local role clinical_core_api');
      await context(a,subA,'consent_management');
      stage='active_plan_consent';
      const plansConsent=Number((await tx.query<{revision:number}>("select (clinical_core.set_owned_consumer_consent('protocols_supplements','granted','acceptance-only',0)->>'revision')::int as revision")).rows[0]?.revision);
      if(!Number.isSafeInteger(plansConsent)||plansConsent<1)throw new Error('plans_consent_response_invalid');
      await context(a,subA);
      const planA=randomUUID(),planB=randomUUID(),adoptA=randomUUID(),adoptB=randomUUID(),releaseReq=randomUUID(),hash='a'.repeat(64);
      stage='active_plan_initial_read';
      await check("select clinical_core.get_owned_active_plan()->'current' = 'null'::jsonb as ok");
      stage='active_plan_initial_write';
      await tx.query("select clinical_core.write_owned_consumer_record('protocols',$1,0,$2,'{\"name\":\"fictional\"}'::jsonb,false,$3::integer)",[clinicalUuid(planA),clinicalUuid(randomUUID()),plansConsent]);
      await refused(`clinical_core.adopt_owned_active_plan('${planA}',2,'${hash}',${plansConsent},'${adoptA}',null,null)`,'40001');
      await refused(`clinical_core.adopt_owned_active_plan('${planB}',1,'${hash}',${plansConsent},'${adoptA}',null,null)`,'40001');
      await check(`select (clinical_core.adopt_owned_active_plan('${planA}',1,'${hash}',${plansConsent},'${adoptA}',null,null)->'current'->>'recordId')::uuid=$1 as ok`,[clinicalUuid(planA)]);
      await check(`select (clinical_core.adopt_owned_active_plan('${planA}',1,'${hash}',${plansConsent},'${adoptA}',null,null)->>'duplicate')::boolean as ok`);
      await refused(`clinical_core.adopt_owned_active_plan('${planA}',1,'${hash}',${plansConsent},'${randomUUID()}',null,null)`,'40001');
      await tx.query("select clinical_core.write_owned_consumer_record('protocols',$1,0,$2,'{\"name\":\"fictional-b\"}'::jsonb,false,$3::integer)",[clinicalUuid(planB),clinicalUuid(randomUUID()),plansConsent]);
      await refused(`clinical_core.adopt_owned_active_plan('${planB}',1,'${hash}',${plansConsent},'${adoptB}',null,null)`,'40001');
      await check(`select (clinical_core.adopt_owned_active_plan('${planB}',1,'${hash}',${plansConsent},'${adoptB}','${planA}',1)->'current'->'supersedes'->>'recordId')::uuid=$1 as ok`,[clinicalUuid(planA)]);
      await context(b,subB);
      await refused("clinical_core.get_owned_active_plan()",'42501');
      await check("select count(*)::int=0 as ok from clinical_core.owned_consumer_active_plans where owner_id=$1",[clinicalUuid(a)]);
      await context(a,subA);
      await tx.query("select clinical_core.write_owned_consumer_record('protocols',$1,1,$2,'{}'::jsonb,true,$3::integer)",[clinicalUuid(planB),clinicalUuid(randomUUID()),plansConsent]);
      await check("select clinical_core.get_owned_active_plan()->'current' = 'null'::jsonb as ok");
      await check("select clinical_core.get_owned_active_plan()->'history'->0->>'action'='record_deleted' as ok");
      await refused(`clinical_core.release_owned_active_plan('${releaseReq}','${planB}',1)`,'40001');
      stage='active_plan_api_digest';
      const adoptBody={recordId:planA,revision:1,contentSha256:createHash('sha256').update('{"name":"fictional"}').digest('hex'),consentRevision:plansConsent,requestId:randomUUID(),expectedPrevious:null};
      const planRoute='POST /clinical-core/consumer/personal/active-plan';
      if((await api(apiEvent(a,subA,planRoute,undefined,{...adoptBody,contentSha256:'f'.repeat(64)}))).statusCode!==409)throw new Error('active_plan_wrong_hash_allowed');checks++;
      for(const duplicate of [false,true]){
        const response=await api(apiEvent(a,subA,planRoute,undefined,adoptBody));
        const data=JSON.parse(response.body).data;
        if(response.statusCode!==200||data?.duplicate!==duplicate||data?.current?.contentSha256!==adoptBody.contentSha256)throw new Error('active_plan_api_adoption_failed');checks++;
      }
      const planRead=await api(apiEvent(a,subA,'GET /clinical-core/consumer/personal/active-plan'));
      if(planRead.statusCode!==200||JSON.parse(planRead.body).data?.current?.recordId!==planA)throw new Error('active_plan_api_read_failed');checks++;
      stage='privacy_requests';
      await context(a,subA,'consent_management');
      const deletionReq=randomUUID();
      const submitted=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/privacy-request',undefined,{requestId:deletionReq,kind:'deletion'}));
      if(submitted.statusCode!==200||JSON.parse(submitted.body).data.status!=='submitted')throw new Error('privacy_request_submit_failed');checks++;
      const replayed=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/privacy-request',undefined,{requestId:deletionReq,kind:'deletion'}));
      if(JSON.parse(replayed.body).data.duplicate!==true)throw new Error('privacy_request_replay_failed');checks++;
      await refused(`clinical_core.submit_owned_privacy_request('${randomUUID()}','deletion',null)`,'40001');
      const tombstoned=await api(apiEvent(a,subA,'POST /clinical-core/consumer/personal/privacy-request/tombstone',undefined,{requestId:deletionReq,confirmTombstoneAllPersonalRecords:true}));
      const ledger=JSON.parse(tombstoned.body).data;
      if(tombstoned.statusCode!==200||ledger.status!=='in_progress'||!(ledger.tombstoned>=1))throw new Error('privacy_tombstone_failed');checks++;
      await context(a,subA);
      // Consent was withdrawn earlier; privacy cleanup must not regrant it.
      await refused("clinical_core.list_owned_consumer_records('wellness_profiles',10)",'42501');
      await check("select clinical_core.get_owned_active_plan()->'current' = 'null'::jsonb as ok");
      await context(a,subA,'consent_management');
      // Workforce-only operations refuse the consumer; a held request cannot purge.
      await refused(`clinical_private.complete_owned_privacy_request('${ledger.privacyRequestId}')`,'42501');
      await refused(`clinical_private.purge_owned_personal_history('${ledger.privacyRequestId}','none')`,'42501');
      await refused(`clinical_private.place_owned_legal_hold('${a}','litigation')`,'42501');
      await check("select jsonb_array_length(clinical_core.list_my_guardian_authorities())=0 as ok");
      await refused(`clinical_private.review_guardian_authority('${b}','${a}','parent_of_minor','birth_record','${'a'.repeat(64)}',clock_timestamp()+interval '1 day')`,'42501');
      await context(b,subB,'consent_management');
      await check("select jsonb_array_length(clinical_core.list_owned_privacy_requests())=0 as ok");
      await context(a,subA);
      await tx.query("select set_config('clinical.claim.identity_pool','workforce',true)");
      await refused("clinical_private.owned_consumer_actor()", "42501");
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) { console.error(JSON.stringify({ failedStage: stage, passedChecks: checks })); throw error; }
  }
  const remaining = await database.transaction(async tx => tx.query<{ ok: boolean }>(
    "select to_regclass('clinical_core.owned_consumer_record_versions') is null and to_regclass('clinical_private.owned_privacy_exports') is null and to_regclass('clinical_audit.owned_privacy_export_events') is null and to_regclass('clinical_core.owned_consumer_active_plans') is null and to_regclass('clinical_core.owned_consumer_active_plan_history') is null and to_regclass('clinical_private.owned_privacy_requests') is null and to_regclass('clinical_core.guardian_authorities') is null and not exists(select 1 from clinical_core.identities where identity_subject in ($1,$2)) as ok", [subA,subB]));
  if (remaining.rows[0]?.ok !== true) throw new Error("rollback_verification_failed");
  console.log(JSON.stringify({ checks, rollbackVerified: true, retainedSchema: false, retainedFixtureRows: 0, clinicConnectionRequired: false, phiAllowed: false }));
}
run().catch(() => { console.error("owned_consumer_records_acceptance_failed"); process.exitCode = 1; });
