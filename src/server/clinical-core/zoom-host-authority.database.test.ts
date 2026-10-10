import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase } from './database';
import { createZoomHostRegistry, type ZoomHostFunctionPin } from './zoom-host-registry';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { GetSecretValueCommand, type GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager';
import { createZoomHostCredentialResolver } from './zoom-host-credentials';
import { runZoomCredentialRequest } from './zoom-credential-snapshot';

// Actual canonical112 SQL plus the unreleased candidate, in memory only.
// Every identity, review and record below is FICTIONAL, not deployment evidence.
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string,string> };
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let db: PGlite, artifact: Artifact;
let sourceSql:string, pins:ZoomHostFunctionPin[];
let org: string, foreign: string, practitioner: string, colleague: string, reviewer: string, consumer: string, staff: string, patient: string, appointment: string;
const config = (changes: Record<string,unknown> = {}) => ({ runtimeMode: 'qualification', awsAccountId: '588966314750', region: 'us-east-2',
  zoomAccountId: 'fictional-zoom-account', zoomHostId: 'fictional-zoom-host', clientId: 'fictional-oauth-client', sdkAppKey: 'fictional-sdk-key',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-zoom-AbCd12', secretVersionId: '1'.repeat(32),
  providerReviewSha256: sha('FICTIONAL provider review, NOT APPROVAL'), securityReviewSha256: sha('FICTIONAL security review, NOT APPROVAL'),
  sdkAuthorizationReviewSha256: sha('FICTIONAL SDK review, NOT APPROVAL'), ...changes });
async function release(revision = 1, configuration = config(), person = practitioner, organization = org, reviewedBy = reviewer,
  time = "clock_timestamp()-interval '1 minute'", expiry = "clock_timestamp()+interval '1 day'") {
  const id = randomUUID();
  await db.query(`insert into clinical_telehealth.zoom_host_releases(id,organization_id,practitioner_person_id,revision,configuration,
    configuration_sha256,reviewed_by_person_id,reviewed_at,expires_at) values($1,$2,$3,$4,$5::jsonb,
    encode(public.digest(convert_to(($5::jsonb)::text,'UTF8'),'sha256'),'hex'),$6,${time},${expiry})`,
    [id,organization,person,revision,JSON.stringify(configuration),reviewedBy]);
  return id;
}
async function call(verb: 'bind'|'read', args: unknown[], who = practitioner, organization = org, pool = 'workforce', subject = 'fixture-'+who) {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,'clinical_data','production-clinical','clinical_phi')",[who,organization,pool,subject]);
    const sql = verb === 'bind' ? 'select clinical_telehealth.bind_visit_host($1,$2) data' : 'select clinical_telehealth.read_visit_host_binding($1,$2) data';
    return (await tx.query<{ data: Record<string,unknown> }>(sql,args)).rows[0].data;
  });
}
const bind = (intent: string = randomUUID()) => call('bind',[appointment,intent]);
const read = (purpose = 'new_processing', who = practitioner) => call('read',[appointment,purpose],who);
const count = async (table = 'zoom_visit_host_bindings') => (await db.query<{ n:number }>('select count(*)::int n from clinical_telehealth.'+table)).rows[0].n;
async function revoke(id: string, who = reviewer) {
  return db.query("insert into clinical_telehealth.zoom_host_revocations(release_id,revoked_by_person_id,reason_code) values($1,$2,'security_hold')",[id,who]);
}
beforeAll(async () => {
  artifact = JSON.parse(execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],
    { encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true }));
  db = new PGlite({ extensions: { pgcrypto } });
  const migrations = artifact.manifest.migrations.map(row => ({ version: row.version, name: row.file.slice(15,-4),
    sql: artifact.files[row.file], sha256: sha(artifact.files[row.file]) }));
  const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({
    query: (sql, parameters = []) => tx.query(sql,[...parameters]),
  })) };
  await applyProductionClinicalCoreMigrations(admin,migrations.slice(0,106));
  // Forward source rehearsal with fictional ledger receipts in memory only.
  // This does not apply an approved upgrade, or mint a release for this candidate.
  for (const row of migrations.slice(106)) {
    await db.exec(row.sql);
    await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[row.version,row.name,row.sha256]);
  }
  sourceSql=readFileSync('infra/aws-clinical-core/source-candidates/zoom-host-authority.sql','utf8').replace(/\r\n?/g,'\n');
  await db.exec(sourceSql);
  const bodies=new Map<string,string>();
  // Expected bodies come from trusted compiled SOURCE, not live catalog reads.
  for(const sql of [...migrations.map(m=>m.sql),sourceSql]) for(const [,name,body] of sql.matchAll(/create(?: or replace)? function (clinical_(?:private|telehealth)\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)) bodies.set(name,body);
  pins=[...bodies].filter(([name])=>name.startsWith('clinical_telehealth.')||[
    'clinical_private.claim','clinical_private.actor_person_id','clinical_private.organization_id','clinical_private.set_request_context','clinical_private.block_update_delete',
  ].includes(name)).map(([name,body])=>({name,bodySha256:sha(body)}));
  for (const table of ['zoom_host_releases','zoom_host_revocations','zoom_visit_host_bindings','host_authority_events']) expect(await count(table)).toBe(0);
},60000);
afterAll(async()=>{ await db?.close(); });
beforeEach(async () => {
  // Superuser reset only in this isolated, in-memory test database.
  await db.exec('truncate clinical_telehealth.host_authority_events,clinical_telehealth.zoom_visit_host_bindings,clinical_telehealth.zoom_host_revocations,clinical_telehealth.zoom_host_releases');
  [org,foreign,practitioner,colleague,reviewer,consumer,staff,patient,appointment]=Array.from({length:9},()=>randomUUID());
  for (const id of [org,foreign]) await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL HOST TEST')",[id]);
  for (const [id,pool,role] of [[practitioner,'workforce','practitioner'],[colleague,'workforce','practitioner'],[reviewer,'workforce','owner'],[consumer,'consumer',''],[staff,'workforce','staff']]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,pool,'fixture-'+id]);
    if (role) await db.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)',[org,id,role]);
  }
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",[patient,org,'patient_'+patient.replaceAll('-','')]);
  await db.query(`insert into clinical_core.appointments(id,organization_id,patient_record_id,practitioner_person_id,appointment_type,
    starts_at,ends_at,created_by_person_id,updated_by_person_id) values($1,$2,$3,$4,'telehealth','2026-10-10T17:00:00Z','2026-10-10T17:30:00Z',$4,$4)`,[appointment,org,patient,practitioner]);
});

const context=():ProductionClinicalRequestContext=>({actorPersonId:practitioner,organizationId:org,identityPool:'workforce',identitySubject:'fixture-'+practitioner,
  purpose:'clinical_data',environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true});
const target={runtimeMode:'qualification',awsAccountId:'588966314750',region:'us-east-2'} as const;
const portDatabase=(fault?:(sql:string,result:{rows:Record<string,unknown>[]})=>void):ClinicalCoreDatabase=>({transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  return work({query:async<Row extends Record<string,unknown>>(sql:string,args:readonly unknown[]=[])=>{
    const result=await tx.query<Row>(sql,args.map(v=>v&&typeof v==='object'&&'kind' in v&&v.kind==='uuid'&&'value' in v?v.value:v));
    fault?.(sql,result); return result;
  }});
})});
describe('unreleased typed registry port composed with the real restricted SQL',()=>{
  it('binds and reads exact source-pinned metadata without claiming provider authority',async()=>{
    await release(); const registry=createZoomHostRegistry(portDatabase(),pins,target), intent=randomUUID();
    const first=await registry(context(),{action:'bind',appointmentId:appointment,intentId:intent});
    const second=await registry(context(),{action:'read',appointmentId:appointment,purpose:'new_processing'});
    expect(second.bindingId).toBe(first.bindingId); expect(first.providerActionAuthorized).toBe(false);
    expect(Object.isFrozen(first)&&Object.isFrozen(first.configuration)).toBe(true);
  });
  it.each([
    "grant select on clinical_telehealth.zoom_host_releases to clinical_core_api",
    "grant select(configuration) on clinical_telehealth.zoom_host_releases to clinical_core_api",
    "grant select on clinical_telehealth.zoom_host_releases to public",
    "alter table clinical_telehealth.zoom_host_releases no force row level security",
    "alter table clinical_telehealth.zoom_host_releases disable row level security",
    "create policy unexpected on clinical_telehealth.zoom_host_releases using(true)",
    "alter table clinical_telehealth.zoom_host_releases disable trigger zoom_host_release_guard",
    "grant execute on function clinical_telehealth.read_visit_host_binding(uuid,text) to public",
    "grant execute on function clinical_telehealth.valid_host_configuration(jsonb) to clinical_core_api",
    "create function clinical_telehealth.read_visit_host_binding(uuid) returns jsonb language sql as 'select null::jsonb'",
  ])('refuses changed contract before setting identity context: %s',async mutation=>{
    await release();
    let entered=false;
    try {
      await db.transaction(async tx=>{
        await tx.exec(mutation);
        const altered:ClinicalCoreDatabase={transaction:work=>work({query:async<Row extends Record<string,unknown>>(sql:string,args:readonly unknown[]=[])=>{
          await tx.exec('set local role clinical_core_api');
          if(sql.includes('set_request_context')) entered=true;
          return tx.query<Row>(sql,[...args]);
        }})};
        await expect(createZoomHostRegistry(altered,pins,target)(context(),{action:'bind',appointmentId:appointment,intentId:randomUUID()})).rejects.toThrow('service_unavailable');
        expect(entered).toBe(false);
        throw Error('FICTIONAL rollback test mutation');
      });
    } catch(error) { expect((error as Error).message).toBe('FICTIONAL rollback test mutation'); }
  });
  it('refuses changed helper function bytes and does not learn new pins from the live target',async()=>{
    await release();
    await expect(db.transaction(async tx=>{
      await tx.exec("create or replace function clinical_private.actor_person_id() returns uuid language sql stable set search_path='' as 'select null::uuid'");
      const altered:ClinicalCoreDatabase={transaction:work=>work({query:async<Row extends Record<string,unknown>>(sql:string,args:readonly unknown[]=[])=>{
        await tx.exec('set local role clinical_core_api'); return tx.query<Row>(sql,[...args]);
      }})};
      await expect(createZoomHostRegistry(altered,pins,target)(context(),{action:'bind',appointmentId:appointment,intentId:randomUUID()})).rejects.toThrow('service_unavailable');
      throw Error('FICTIONAL rollback test mutation');
    })).rejects.toThrow('FICTIONAL rollback test mutation');
  });
  it.each(['organizationId','appointmentId','intentId','configurationSha256','providerActionAuthorized','purpose','extra'] as const)('refuses substituted response %s and rolls back the binding',async field=>{
    await release();
    const registry=createZoomHostRegistry(portDatabase((sql,result)=>{
      if(!sql.startsWith('select clinical_telehealth.bind_visit_host')) return;
      const data=result.rows[0].data as Record<string,unknown>;
      data[field]=field==='providerActionAuthorized'?true:field==='configurationSha256'?'1'.repeat(64):field==='purpose'?'cleanup_metadata':field==='extra'?'unexpected':randomUUID();
    }),pins,target);
    await expect(registry(context(),{action:'bind',appointmentId:appointment,intentId:randomUUID()})).rejects.toThrow('service_unavailable');
    expect(await count()).toBe(0);
  });
  it('does not enter a database transaction for a consumer or malformed request',async()=>{
    let entered=false; const never:ClinicalCoreDatabase={transaction:async()=>{entered=true;throw Error('never');}};
    const registry=createZoomHostRegistry(never,pins,target);
    await expect(registry({...context(),identityPool:'consumer'},{action:'bind',appointmentId:appointment,intentId:randomUUID()})).rejects.toThrow('identity_refused');
    await expect(registry(context(),{action:'bind',appointmentId:'not-uuid',intentId:randomUUID()})).rejects.toThrow('request_invalid');
    expect(entered).toBe(false);
  });
  it('retained metadata stays pinned to the original configuration after rotation',async()=>{
    await release(); const registry=createZoomHostRegistry(portDatabase(),pins,target);
    const first=await registry(context(),{action:'bind',appointmentId:appointment,intentId:randomUUID()});
    await release(2,config({secretVersionId:'2'.repeat(32)}));
    const retained=await registry(context(),{action:'read',appointmentId:appointment,purpose:'cleanup_metadata'});
    expect(retained.configuration.secretVersionId).toBe(first.configuration.secretVersionId);
    expect(retained.providerActionAuthorized).toBe(false);
    await expect(registry(context(),{action:'read',appointmentId:appointment,purpose:'new_processing'})).rejects.toThrow('service_unavailable');
  });
  it('refuses production configuration through the qualification port without committing a binding',async()=>{
    await release(1,config({runtimeMode:'production',awsAccountId:'173535830222',secretArn:'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional-zoom-AbCd12'}));
    const registry=createZoomHostRegistry(portDatabase(),pins,target);
    await expect(registry(context(),{action:'bind',appointmentId:appointment,intentId:randomUUID()})).rejects.toThrow('service_unavailable');
    expect(await count()).toBe(0);
  });
});

describe('version-pinned credential resolver composed with real SQL authority',()=>{
  const secretValue=()=>JSON.stringify({accountId:config().zoomAccountId,clientId:config().clientId,clientSecret:'fictional-client-secret',
    userId:config().zoomHostId,sdkKey:config().sdkAppKey,sdkSecret:'fictional-sdk-secret'});
  const reply=():GetSecretValueCommandOutput=>({$metadata:{httpStatusCode:200},ARN:config().secretArn,VersionId:config().secretVersionId,SecretString:secretValue()});
  const signal=()=>AbortSignal.timeout(10_000);
  async function setup() {
    const releaseId=await release();
    const registry=createZoomHostRegistry(portDatabase(),pins,target);
    const original=await registry(context(),{action:'bind',appointmentId:appointment,intentId:randomUUID()});
    const send=vi.fn(async(_command:GetSecretValueCommand,_options:{abortSignal:AbortSignal})=>reply());
    const resolver=createZoomHostCredentialResolver({database:portDatabase(),compiledPins:pins,compiledTarget:target,
      allowedSecretArns:[config().secretArn],secretReader:{send}});
    return {releaseId,registry,original,send,resolver};
  }
  it('requests only the reviewed ARN and exact VersionId and checks actual account, client, host and SDK fields',async()=>{
    const f=await setup();
    const credentials=await runZoomCredentialRequest(()=>f.resolver(context(),f.original,signal()));
    expect(credentials).toMatchObject({accountId:config().zoomAccountId,clientId:config().clientId,userId:config().zoomHostId,sdkKey:config().sdkAppKey});
    expect(Object.isFrozen(credentials)).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toBeInstanceOf(GetSecretValueCommand);
    expect(f.send.mock.calls[0][0].input).toEqual({SecretId:config().secretArn,VersionId:config().secretVersionId});
    expect(f.send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it('shares one version read within a request but refreshes the next request',async()=>{
    const f=await setup();
    await runZoomCredentialRequest(async()=>{
      await f.resolver(context(),f.original,signal()); await f.resolver(context(),f.original,signal());
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    await runZoomCredentialRequest(()=>f.resolver(context(),f.original,signal()));
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each(['ARN','VersionId','SecretString','SecretBinary','status','accountId','clientId','userId','sdkKey','sdkSecret'] as const)('refuses a missing/wrong %s without a fallback or leaked credential',async key=>{
    const f=await setup();
    f.send.mockImplementation(async()=>{
      const output=reply();
      if(key==='ARN') output.ARN='arn:aws:secretsmanager:us-east-2:588966314750:secret:other-AbCd12';
      else if(key==='VersionId') output.VersionId='2'.repeat(32);
      else if(key==='SecretString') output.SecretString=undefined;
      else if(key==='SecretBinary') output.SecretBinary=new Uint8Array([1]);
      else if(key==='status') output.$metadata.httpStatusCode=503;
      else { const values=JSON.parse(secretValue()); values[key]=key==='sdkSecret'?null:'different'; output.SecretString=JSON.stringify(values); }
      return output;
    });
    await expect(runZoomCredentialRequest(()=>f.resolver(context(),f.original,signal()))).rejects.toThrow(/^zoom_credentials_refused$/);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each(['cleanup','wrong_clinic','consumer','unscoped','unadmitted','changed_configuration','substituted_binding','secret_not_allowed'] as const)('refuses %s before any secret read',async problem=>{
    const f=await setup();
    const original=problem==='cleanup'?await f.registry(context(),{action:'read',appointmentId:appointment,purpose:'cleanup_metadata'}):
      problem==='unadmitted'?{...f.original,bindingId:randomUUID(),appointmentId:randomUUID()}:
      problem==='changed_configuration'?{...f.original,configuration:{...f.original.configuration,secretVersionId:'2'.repeat(32)}}:
      problem==='substituted_binding'?{...f.original,bindingId:randomUUID()}:f.original;
    const actor=problem==='wrong_clinic'?{...context(),organizationId:foreign}:problem==='consumer'?{...context(),identityPool:'consumer' as const}:context();
    const resolver=problem==='secret_not_allowed'?createZoomHostCredentialResolver({database:portDatabase(),compiledPins:pins,compiledTarget:target,
      allowedSecretArns:['arn:aws:secretsmanager:us-east-2:588966314750:secret:not-this-host-AbCd12'],secretReader:{send:f.send}}):f.resolver;
    const work=()=>resolver(actor,original,signal());
    await expect(problem==='unscoped'?work():runZoomCredentialRequest(work)).rejects.toThrow(/^zoom_credentials_refused$/);
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(['rotation','revocation','host_membership','patient_archived','rescheduled','reassigned'] as const)('withholds credentials when %s changes during secret read',async change=>{
    const f=await setup();
    f.send.mockImplementation(async()=>{
      if(change==='rotation') await release(2,config({secretVersionId:'2'.repeat(32)}));
      else if(change==='revocation') await revoke(f.releaseId);
      else if(change==='host_membership') await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",[org,practitioner]);
      else if(change==='patient_archived') await db.query("update clinical_core.patient_records set status='archived' where id=$1",[patient]);
      else if(change==='rescheduled') await db.query("update clinical_core.appointments set starts_at=starts_at+interval '5 minutes' where id=$1",[appointment]);
      else await db.query('update clinical_core.appointments set practitioner_person_id=$2 where id=$1',[appointment,colleague]);
      return reply();
    });
    await expect(runZoomCredentialRequest(()=>f.resolver(context(),f.original,signal()))).rejects.toThrow(/^zoom_credentials_refused$/);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('rechecks authority even on a cached version read',async()=>{
    const f=await setup();
    await runZoomCredentialRequest(async()=>{
      await f.resolver(context(),f.original,signal());
      await revoke(f.releaseId);
      await expect(f.resolver(context(),f.original,signal())).rejects.toThrow(/^zoom_credentials_refused$/);
    });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('does not retry a failed version read or fall back to current credentials in the same request',async()=>{
    const f=await setup(); f.send.mockRejectedValue(new Error('FICTIONAL secret or bearer must not escape'));
    await runZoomCredentialRequest(async()=>{
      await expect(f.resolver(context(),f.original,signal())).rejects.toThrow(/^zoom_credentials_refused$/);
      await expect(f.resolver(context(),f.original,signal())).rejects.toThrow(/^zoom_credentials_refused$/);
    });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('refuses pre-aborted work without secret access',async()=>{
    const f=await setup(); const controller=new AbortController();controller.abort();
    await expect(runZoomCredentialRequest(()=>f.resolver(context(),f.original,controller.signal))).rejects.toThrow(/^zoom_credentials_refused$/);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('propagates cancellation to a stalled secret read and never returns a late credential',async()=>{
    const f=await setup(); const controller=new AbortController(); let started!:()=>void, releaseRead!:(value:GetSecretValueCommandOutput)=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    f.send.mockImplementation((_command,options)=>{expect(options.abortSignal.aborted).toBe(false);started();return new Promise(resolve=>{releaseRead=resolve;});});
    await runZoomCredentialRequest(async()=>{
      const pending=f.resolver(context(),f.original,controller.signal);
      const assertion=expect(pending).rejects.toThrow(/^zoom_credentials_refused$/);
      await ready;controller.abort();await assertion;
      expect(f.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
      releaseRead(reply());
    });
  });
  it('rejects malformed, wildcard, foreign and duplicate deployment allowlists',async()=>{
    for(const allowed of [[],['*'],[config().secretArn,config().secretArn],['arn:aws:secretsmanager:us-east-2:173535830222:secret:foreign-AbCd12']])
      expect(()=>createZoomHostCredentialResolver({database:portDatabase(),compiledPins:pins,compiledTarget:target,allowedSecretArns:allowed})).toThrow(/^zoom_credentials_refused$/);
  });
});

describe('unreleased clinic-specific Zoom host registry under real SQL authority',()=>{
  it('has no seeded releases and no global-host fallback',async()=>{
    await expect(bind()).rejects.toThrow('zoom_host_current_release_required');
    expect(await count()).toBe(0);
  });
  it('admits one immutable same-clinic host binding and replays the exact intent without another binding/event',async()=>{
    const id=await release(), intent=randomUUID();
    const first=await bind(intent), second=await bind(intent);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ organizationId:org,appointmentId:appointment,patientRecordId:patient,practitionerPersonId:practitioner,
      appointmentVersion:1,releaseId:id,intentId:intent,configuration:config(),providerActionAuthorized:false });
    expect(await count()).toBe(1);
    expect((await db.query<{n:number}>("select count(*)::int n from clinical_telehealth.host_authority_events where action='binding_admitted'")).rows[0].n).toBe(1);
  });
  it('refuses a different intent instead of replacing a bound host',async()=>{
    await release(); await bind();
    await expect(bind()).rejects.toThrow('zoom_host_binding_conflict'); expect(await count()).toBe(1);
  });
  it('chooses the newest release before checking revocation and never falls back',async()=>{
    await release(); const newest=await release(2,config({secretVersionId:'2'.repeat(32)})); await revoke(newest);
    await expect(bind()).rejects.toThrow('zoom_host_current_release_required'); expect(await count()).toBe(0);
  });
  it('keeps the original secret version for cleanup metadata after rotation, but refuses new processing',async()=>{
    const original=await release(); const first=await bind(); await release(2,config({secretVersionId:'2'.repeat(32),zoomHostId:'another-host'}));
    await expect(read()).rejects.toThrow('zoom_host_binding_conflict');
    expect(await read('cleanup_metadata')).toMatchObject({bindingId:first.bindingId,releaseId:original,configuration:config(),purpose:'cleanup_metadata',providerActionAuthorized:false});
  });
  it('keeps revoked releases as metadata, not renewed provider authority',async()=>{
    const id=await release(); await bind(); await revoke(id);
    await expect(read()).rejects.toThrow('zoom_host_current_release_required');
    expect(await read('cleanup_metadata')).toMatchObject({releaseId:id,providerActionAuthorized:false});
  });
  it('does not fall back when the newest immutable release expires',async()=>{
    await release();
    await release(2,config({secretVersionId:'2'.repeat(32)}),practitioner,org,reviewer,
      "clock_timestamp()-interval '1 minute'","clock_timestamp()+interval '50 milliseconds'");
    await db.query('select pg_sleep(0.1)');
    await expect(bind()).rejects.toThrow('zoom_host_current_release_required');
    expect(await count()).toBe(0);
  });
  it('archiving the patient stops new admissions and processing but preserves recovery metadata',async()=>{
    await release(); const first=await bind();
    await db.query("update clinical_core.patient_records set status='archived' where id=$1",[patient]);
    await expect(bind(first.intentId as string)).rejects.toThrow('zoom_host_appointment_refused');
    await expect(read()).rejects.toThrow('zoom_host_appointment_refused');
    expect(await read('cleanup_metadata')).toMatchObject({bindingId:first.bindingId,providerActionAuthorized:false});
  });
  it('rechecks identity withdrawal even after a valid request context was admitted',async()=>{
    await release(); await bind();
    await expect(db.transaction(async tx=>{
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')",[practitioner,org,'fixture-'+practitioner]);
      await tx.query("update clinical_core.identities set status='disabled' where person_id=$1",[practitioner]);
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_telehealth.read_visit_host_binding($1,'cleanup_metadata')",[appointment]);
    })).rejects.toThrow('zoom_host_actor_refused');
  });
  it('only a current same-clinic owner or admin can revoke a release',async()=>{
    const id=await release();
    for(const actor of [practitioner,colleague,staff,consumer]) await expect(revoke(id,actor)).rejects.toThrow('zoom_host_review_required');
    expect(await count('zoom_host_revocations')).toBe(0);
    await revoke(id); expect(await count('zoom_host_revocations')).toBe(1);
  });
  it.each(['staff','colleague','consumer','foreign'] as const)('refuses %s admission before writing a binding',async who=>{
    await release();
    const actor=who==='staff'?staff:who==='colleague'?colleague:who==='consumer'?consumer:practitioner;
    await expect(call('bind',[appointment,randomUUID()],actor,who==='foreign'?foreign:org,who==='consumer'?'consumer':'workforce')).rejects.toThrow(/zoom_host_(actor|appointment)_refused/);
    expect(await count()).toBe(0);
  });
  it('refuses a forged identity subject and missing context',async()=>{
    await release();
    await expect(call('bind',[appointment,randomUUID()],practitioner,org,'workforce','wrong-subject')).rejects.toThrow('request_context_refused');
    await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.query('select clinical_telehealth.bind_visit_host($1,$2)',[appointment,randomUUID()]);})).rejects.toThrow('zoom_host_actor_refused');
  });
  it.each(['practitioner','reviewer'] as const)('suspended %s membership stops current authority',async who=>{
    await release(); await bind();
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",[org,who==='practitioner'?practitioner:reviewer]);
    await expect(read()).rejects.toThrow(/zoom_host_(actor_refused|current_release_required)/);
  });
  it.each(['cancelled','deleted','reassigned','rescheduled','version','patient_removed','not_telehealth'] as const)('refuses %s calendar changes without changing the original binding',async change=>{
    await release(); const first=await bind();
    const clause=change==='cancelled'?"status='cancelled'":change==='deleted'?'deleted_at=clock_timestamp()':change==='reassigned'?`practitioner_person_id='${colleague}'`:
      change==='rescheduled'?"starts_at=starts_at+interval '5 minutes'":change==='version'?'version=version+1':change==='patient_removed'?'patient_record_id=null':"appointment_type='break'";
    await db.query('update clinical_core.appointments set '+clause+' where id=$1',[appointment]);
    await expect(read()).rejects.toThrow('zoom_host_appointment_refused');
    expect(await read('cleanup_metadata')).toMatchObject({bindingId:first.bindingId,practitionerPersonId:practitioner,patientRecordId:patient,providerActionAuthorized:false});
  });
  it('does not give a colleague retained recovery metadata; a current clinic owner can inspect it',async()=>{
    await release(); await bind();
    await expect(read('cleanup_metadata',colleague)).rejects.toThrow('zoom_host_actor_refused');
    expect(await read('cleanup_metadata',reviewer)).toMatchObject({providerActionAuthorized:false});
    await expect(call('read',[appointment,'cleanup_metadata'],practitioner,foreign)).rejects.toThrow('zoom_host_actor_refused');
  });
  it.each(['start','delete','end','SDK','',null])('metadata purpose %j cannot invent a provider action',async purpose=>{
    await release(); await bind(); await expect(call('read',[appointment,purpose])).rejects.toThrow('zoom_host_binding_invalid');
  });
  it.each([{region:'us-west-2'},{awsAccountId:'173535830222'},{secretArn:'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional-AbCd12'},
    {secretVersionId:'AWSCURRENT'},{zoomHostId:'me'},{zoomHostId:'host@example.test'},{providerReviewSha256:'0'.repeat(64)},
    {sdkAuthorizationReviewSha256:null},{securityReviewSha256:false},{extra:'not-reviewed'}])('rejects unreviewable credential configuration %j',async change=>{
    await expect(release(1,config(change))).rejects.toThrow(/check constraint/); expect(await count('zoom_host_releases')).toBe(0);
  });
  it('does not permit the API role to insert approvals, revocations, bindings or audit rows, or read raw tables',async()=>{
    for(const table of ['zoom_host_releases','zoom_host_revocations','zoom_visit_host_bindings','host_authority_events']) {
      for(const sql of ['select * from ','insert into ']) await expect(db.transaction(async tx=>{
        await tx.exec('set local role clinical_core_api');
        await tx.exec(sql+'clinical_telehealth.'+table+(sql.startsWith('insert')?' default values':''));
      })).rejects.toThrow(/permission denied/);
    }
  });
  it.each(['revision','reviewer','future','foreign'] as const)('refuses release registration with invalid %s',async problem=>{
    await expect(release(problem==='revision'?2:1,config(),practitioner,problem==='foreign'?foreign:org,problem==='reviewer'?practitioner:reviewer,
      problem==='future'?"clock_timestamp()+interval '1 hour'":"clock_timestamp()-interval '1 minute'")).rejects.toThrow('zoom_host_review_required');
  });
  it('prevents mutation/deletion of releases, revocations, bindings and events even through the test owner',async()=>{
    const id=await release(); await bind(); await revoke(id);
    for(const [table,column] of [['zoom_host_releases','revision'],['zoom_host_revocations','reason_code'],['zoom_visit_host_bindings','intent_id'],['host_authority_events','action']]) {
      await expect(db.exec('update clinical_telehealth.'+table+' set '+column+'='+column)).rejects.toThrow(/immutable|append_only_record/);
      await expect(db.exec('delete from clinical_telehealth.'+table)).rejects.toThrow(/immutable|append_only_record/);
    }
  });
  it('has forced RLS and no PUBLIC execution on any candidate function',async()=>{
    const rows=(await db.query<{relrowsecurity:boolean;relforcerowsecurity:boolean}>("select relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='clinical_telehealth' and c.relkind='r'")).rows;
    expect(rows).toHaveLength(4); expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
    expect((await db.query<{n:number}>("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a where n.nspname='clinical_telehealth' and a.grantee=0 and a.privilege_type='EXECUTE'")).rows[0].n).toBe(0);
  });
});
