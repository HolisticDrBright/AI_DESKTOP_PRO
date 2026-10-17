import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createOwnedConsumerApi,type OwnedConsumerApiConfiguration} from './owned-consumer-api';
import {createOwnedPrivacyExport,PRIVACY_EXPORT_PAGE_BYTES,PRIVACY_EXPORT_SEGMENTED_READ_RELEASE,PRIVACY_EXPORT_SEGMENT_BYTES,
  PRIVACY_EXPORT_SEGMENTS_PROSRC,PRIVACY_EXPORT_SEGMENTS_ROLLBACK_SHA256,PRIVACY_EXPORT_SEGMENTS_SHA256} from './owned-privacy-export';
import {createOwnedPrivacyExportJobs,type PrivacyExportObjectStorage,type PrivacyExportStore} from './owned-privacy-export-job';
import {classifyDatabaseRejection,RdsDataDatabaseError} from './rds-data-database';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {ApiGatewayV2Event} from './aws-identity-api';

/**
 * A saved lab analysis larger than the privacy-export page bound (docs/privacy-export-oversized-records-2026-10-17.md).
 * The real production chain in PGlite, fictional owners and a fictional object store; no hosted database, bucket or
 * account. The transport classifies database errors with the production classifier (rds-data-database.ts) and returns
 * JSON columns as the raw text PostgreSQL sends, as the Data API does. PGlite is not Aurora and this is not the RDS Data
 * API: its 64 KiB per-row limit is not observed here; each row's text is only measured (a hosted hold).
 */
const read=(path:string)=>readFileSync(path,'utf8').replaceAll('\r\n','\n');
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const CANDIDATE='infra/aws-clinical-core/source-candidates/owned-privacy-export-segments.sql';
const ROLLBACK='infra/aws-clinical-core/source-candidates/owned-privacy-export-segments-rollback.sql';
const SEGMENTS='clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb)';
const DEPLOYED_READ='clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb)';
const ACTOR='clinical_private.owned_consumer_actor()';
const TOO_LARGE='record_exceeds_export_page';
const DATA_API_ROW_BYTES=64*1024;
const org=randomUUID();
let schema:{manifest:{migrations:Array<{file:string}>};files:Record<string,string>};

type Hooks={rows?:(sql:string,rows:Record<string,unknown>[])=>Record<string,unknown>[];before?:(sql:string)=>void};
type Fixture={db:PGlite;hooks:Hooks;rowBytes:number[];segmentCalls:string[]};
const raw={parsers:{114:(v:string)=>v,3802:(v:string)=>v}}; // json and jsonb as the server's own text
function transport(f:Fixture):ClinicalCoreDatabase{
  return {transaction:async work=>f.db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    return work({query:async(sql:string,args:unknown[]=[])=>{
      f.hooks.before?.(sql);
      let result;
      try{result=await tx.query<Record<string,unknown>>(sql,args.map(v=>typeof v==='object'&&v!==null&&'kind' in v&&(v as {kind:string}).kind==='uuid'?(v as unknown as {value:string}).value:v),raw);}
      catch(error){throw classifyDatabaseRejection({name:'DatabaseErrorException',message:error instanceof Error?error.message:String(error)})??new RdsDataDatabaseError('query_failed');}
      if(sql.includes('read_owned_privacy_export'))for(const row of result.rows)f.rowBytes.push(Buffer.byteLength(Object.values(row).map(String).join(''),'utf8'));
      if(sql.includes('read_owned_privacy_export_segments'))f.segmentCalls.push(String(result.rows[0]?.result));
      return {rows:f.hooks.rows?f.hooks.rows(sql,result.rows):result.rows,rowCount:result.rows.length};
    }} as unknown as ClinicalCoreTransaction);
  })} as ClinicalCoreDatabase;
}
const context=(who:string):ProductionClinicalRequestContext=>({actorPersonId:who,organizationId:org,identityPool:'consumer',identitySubject:'subject-'+who,
  purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true});
const adapterOf=(f:Fixture)=>createOwnedConsumerRecordsAdapter(transport(f));
const runOf=(f:Fixture)=><T,>(c:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>adapterOf(f).runPrivacy(c,work);
/** The adapter the consumer API would hold, with the records reader under the given release. */
const adapterWith=(f:Fixture,segmentedRead:'blocked'|'qualification')=>{
  const base=adapterOf(f);
  return {...base,...createOwnedPrivacyExport(runOf(f),{segmentedRead} as never)};
};

async function build(withCandidate:boolean):Promise<Fixture>{
  const db=new PGlite({extensions:{pgcrypto}});
  for(const migration of schema.manifest.migrations)await db.exec(schema.files[migration.file]!);
  if(withCandidate)await db.exec(read(CANDIDATE));
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL export oversize')",[org]);
  await db.exec(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at) values
    ('lab_history','fictional-labs','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'TEST NOT APPROVAL',now()),
    ('forms_checkins','fictional-forms','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'TEST NOT APPROVAL',now())`);
  return {db,hooks:{},rowBytes:[],segmentCalls:[]};
}
const asOwner=(f:Fixture,who:string,sql:string,params:unknown[],purpose='clinical_data')=>f.db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,$4,'production-clinical','clinical_phi')",[who,org,'subject-'+who,purpose]);
  return tx.query<{result:Record<string,unknown>}>(sql,params);
});
/** A fictional lab analysis whose stored text is about `bytes` octets; mixed-width text so segment boundaries split characters. */
function analysis(bytes:number,marker='FICTIONAL'){
  const unit=`${marker} é✓. `;const result={narrative:unit.repeat(Math.floor((bytes-360)/Buffer.byteLength(unit)))};
  return {id:randomUUID(),version:'personal-lab-analysis/1',jobId:randomUUID(),kind:'saved',completedAt:'2026-10-01T00:00:00.000Z',
    resultSha256:sha(JSON.stringify(result)),sourceStatus:'consumer_lab_analysis_unreviewed',result};
}
type Seed={collection:'lab_analyses'|'wellness_profiles';payload:Record<string,unknown>;tombstone?:boolean};
async function person(f:Fixture,seeds:Seed[]){
  const who=randomUUID();
  await f.db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[who,'subject_'+who.replaceAll('-','')]);
  await f.db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)",[who,'subject-'+who]);
  for(const scope of [['lab_history','fictional-labs'],['forms_checkins','fictional-forms']])
    await asOwner(f,who,'select clinical_core.set_owned_consumer_consent($1,$2,$3,0)',[scope[0],'granted',scope[1]],'consent_management');
  for(const seed of seeds){
    const id=typeof seed.payload.id==='string'?seed.payload.id:randomUUID();
    await asOwner(f,who,'select clinical_core.write_owned_consumer_record($1,$2,0,$3,$4::jsonb,false,1) as result',[seed.collection,id,randomUUID(),JSON.stringify(seed.payload)]);
    if(seed.tombstone)await asOwner(f,who,"select clinical_core.write_owned_consumer_record($1,$2,1,$3,'{}'::jsonb,true,1) as result",[seed.collection,id,randomUUID()]);
  }
  return who;
}
const small=(i:number,marker='FICTIONAL'):Seed=>({collection:'wellness_profiles',payload:{index:i,note:`${marker} small record ${i}`}});
const storedText=async(f:Fixture,recordId:string,revision=1)=>Buffer.from((await f.db.query<{b:Uint8Array}>(
  "select convert_to(payload::text,'UTF8') b from clinical_core.owned_consumer_record_versions where record_id=$1 and revision=$2",[recordId,revision])).rows[0]!.b);

// The consumer API as V2 reaches it: the same handler, routes and status mapping.
const config:OwnedConsumerApiConfiguration={consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FICTIONAL',consumerAudience:'fictionalaudience1234567890',
  phiAllowed:true,activationState:'approved',activationEvidenceSha256:'a'.repeat(64),allowedScopes:['forms_checkins','lab_history']};
const BASE='/clinical-core/consumer/personal/privacy-export';
function event(who:string,routeKey:string,input:{query?:Record<string,string>;body?:unknown}):ApiGatewayV2Event{
  const now=Math.floor(Date.now()/1000);
  return {routeKey,headers:input.body===undefined?{}:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)}),
    ...(input.query?{queryStringParameters:input.query}:{}),
    requestContext:{authorizer:{jwt:{claims:{iss:config.consumerIssuer,aud:config.consumerAudience,sub:'subject-'+who,token_use:'id',email_verified:'true',
      iat:now-5,exp:now+600,auth_time:now-5,'custom:person_id':who,'custom:organization_id':org,'custom:production_bound':'true'}}}}} as unknown as ApiGatewayV2Event;
}
const api=(f:Fixture,segmentedRead:'blocked'|'qualification',store?:PrivacyExportStore)=>createOwnedConsumerApi({configuration:config,
  adapter:()=>adapterWith(f,segmentedRead) as ReturnType<typeof createOwnedConsumerRecordsAdapter>,
  ...(store?{exportJobs:()=>jobsWith(f,store,segmentedRead)}:{})});
const RECORD_KEYS=['collection','recordId','revision','payload','deleted','consentRevision','receivedAt'];
/** The in-app copy exactly as V2's personalPrivacyExport.prepare pages it (limit 25), with that client's own refusals
 * restated as assertions: the page shape, at most 25 items, a progressing cursor, no repeat, counts that match. */
async function inAppCopy(f:Fixture,who:string,segmentedRead:'blocked'|'qualification'){
  const handler=api(f,segmentedRead);
  const started=await handler(event(who,`POST ${BASE}`,{body:{requestId:randomUUID()}}));
  expect(started.statusCode).toBe(200);
  const manifest=JSON.parse(started.body).data;
  const out={manifest,records:[] as Record<string,unknown>[],consents:[] as Record<string,unknown>[],pages:[] as {items:number;bytes:number;responseBytes:number}[]};
  for(const section of ['records','consents'] as const){
    let cursor:string|null=null;const seen=new Set<string>(),cursors=new Set<string>();
    const expected=section==='records'?manifest.recordCount:manifest.consentCount;
    for(let page=0;page<=5000;page++){
      const response=await handler(event(who,`GET ${BASE}`,{query:{exportId:manifest.exportId,section,limit:'25',...(cursor?{cursor}:{})}}));
      if(response.statusCode!==200)return {...out,refused:{status:response.statusCode,error:JSON.parse(response.body).error as string}};
      const value=JSON.parse(response.body).data;
      expect(Object.keys(value).sort()).toEqual(['asOf','exportId','items','nextCursor','section']);
      expect(value).toMatchObject({exportId:manifest.exportId,asOf:manifest.asOf,section});
      expect(value.items.length).toBeLessThanOrEqual(25);
      if(value.nextCursor!==null)expect(value.nextCursor).toMatch(/^[A-Za-z0-9_-]{20,600}$/);
      out.pages.push({items:value.items.length,bytes:Buffer.byteLength(JSON.stringify(value.items)),responseBytes:Buffer.byteLength(response.body)});
      for(const row of value.items){
        const id=section==='records'?`${row.collection}:${row.recordId}:${row.revision}`:`${row.scope}:${row.revision}`;
        expect(seen.has(id)).toBe(false);seen.add(id);
        if(section==='records'){expect(Object.keys(row)).toEqual(RECORD_KEYS);out.records.push(row);}else out.consents.push(row);
      }
      if(value.nextCursor===null){expect(seen.size).toBe(expected);break;}
      expect(value.items.length).toBeGreaterThan(0);expect(seen.size).toBeLessThan(expected);expect(cursors.has(value.nextCursor)).toBe(false);
      cursors.add(value.nextCursor);cursor=value.nextCursor;
    }
  }
  return {...out,refused:null};
}

const storage:PrivacyExportObjectStorage={bucket:'fictional-export-bucket',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:123456789012:key/11111111-1111-4111-8111-111111111111',expectedBucketOwner:'123456789012'};
/** A fictional S3: full-object checksums for PUT, composite checksums for multipart, listing as the job expects. */
function fakeStore(){
  const objects=new Map<string,Map<string,Uint8Array>>(),uploads=new Map<string,{key:string;parts:Map<number,{bytes:Uint8Array;etag:string}>}>();
  const checksums=new Map<string,string>();let versions=0;
  const put=(key:string,bytes:Uint8Array,checksum:string)=>{const v='v'+(++versions);if(!objects.has(key))objects.set(key,new Map());objects.get(key)!.set(v,bytes);checksums.set(key+'\n'+v,checksum);return v;};
  const composite=(parts:Uint8Array[])=>createHash('sha256').update(Buffer.concat(parts.map(p=>createHash('sha256').update(p).digest()))).digest('base64')+'-'+parts.length;
  const store:PrivacyExportStore={
    createUpload:vi.fn(async(_s,key)=>{const uploadId='u-'+randomUUID();uploads.set(uploadId,{key,parts:new Map()});return {uploadId};}),
    uploadPart:vi.fn(async(_s,key,uploadId,partNumber,body,digest)=>{const u=uploads.get(uploadId);if(!u||u.key!==key||sha(body)!==digest)throw new Error('fictional refusal');
      const etag='"'+createHash('md5').update(body).digest('hex')+'"';u.parts.set(partNumber,{bytes:body,etag});return {etag};}),
    completeUpload:vi.fn(async(_s,key,uploadId,parts)=>{const u=uploads.get(uploadId);if(!u||u.key!==key)throw new Error('NoSuchUpload');
      const ordered=parts.map((p:{partNumber:number;etag:string})=>{const stored=u.parts.get(p.partNumber);if(!stored||stored.etag!==p.etag)throw new Error('InvalidPart');return stored.bytes;});
      const checksum=composite(ordered);uploads.delete(uploadId);return {version:put(key,Buffer.concat(ordered),checksum),checksum};}),
    abortUpload:vi.fn(async(_s,_key,uploadId)=>{uploads.delete(uploadId);}),
    put:vi.fn(async(_s,key,body,digest)=>{if(sha(body)!==digest)throw new Error('BadDigest');return {version:put(key,body,createHash('sha256').update(body).digest('base64'))};}),
    get:vi.fn(async(_s,key,v,max)=>{const b=objects.get(key)?.get(v);if(!b||b.byteLength>max)throw new Error('NoSuchVersion');return b;}),
    head:vi.fn(async(_s,key,v,_signal,options)=>{const b=objects.get(key)?.get(v);
      return b?{exists:true,bytes:b.byteLength,encryption:'aws:kms',kmsKeyArn:storage.kmsKeyArn,...(options?.checksum?{checksum:checksums.get(key+'\n'+v)}:{})}:{exists:false};}),
    deleteVersion:vi.fn(async(_s,key,v)=>{objects.get(key)?.delete(v);}),
    signDownload:vi.fn(async(_s,key,v,seconds)=>`https://fictional-export-bucket.s3.us-east-2.amazonaws.com/${key}?versionId=${v}&X-Amz-Expires=${seconds}`),
    listUploads:vi.fn(async(_s,prefix)=>[...uploads.entries()].filter(([,u])=>u.key.startsWith(prefix)).map(([uploadId,u])=>({key:u.key,uploadId}))),
    listVersions:vi.fn(async(_s,prefix)=>[...objects.entries()].filter(([k])=>k.startsWith(prefix)).flatMap(([key,vs])=>[...vs.entries()].map(([version,b])=>({key,version,bytes:b.byteLength,deleteMarker:false})))),
  };
  const document=()=>{const key=[...objects.keys()].find(k=>k.endsWith('.json'))!;const [bytes]=[...objects.get(key)!.values()];return JSON.parse(Buffer.from(bytes!).toString('utf8'));};
  return {store,objects,uploads,document};
}
const jobsWith=(f:Fixture,store:PrivacyExportStore,segmentedRead:'blocked'|'qualification'='blocked')=>
  createOwnedPrivacyExportJobs(runOf(f),{store,storage,partBytes:64*1024,segmentedRead} as never);
async function drive(jobs:ReturnType<typeof jobsWith>,jobId:string,who:string){
  let view=await jobs.getPrivacyExportJob(context(who),{jobId});let passes=0;
  while(['requested','running'].includes(view.status)&&passes<200){view=await jobs.advancePrivacyExportJob(context(who),{jobId},20000,new AbortController().signal);passes++;}
  return {view,passes};
}
const markers=(text:string)=>new Set(text.match(/OWNER-[AB]-ONLY/g)??[]);
/** A new in-app snapshot is refused within a minute of the owner's last one (a job's snapshot counts); a finished job's is aged. */
const age=(f:Fixture,who:string)=>f.db.query("update clinical_private.owned_privacy_exports set as_of=as_of-interval '2 minutes' where owner_id=$1",[who]);

beforeAll(()=>{
  schema=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:30_000}));
  expect(schema.manifest.migrations.some(m=>/privacy[-_]export[-_]segments/.test(m.file))).toBe(false);
});

describe('the deployed schema with the segmented read blocked (the default)',()=>{
  let f:Fixture;
  beforeAll(async()=>{f=await build(false);},120_000);
  afterAll(async()=>{await f?.db.close();});
  afterEach(()=>{f.hooks={};});

  it('is blocked by default, and no production wiring passes an override',()=>{
    expect(PRIVACY_EXPORT_SEGMENTED_READ_RELEASE).toBe('blocked');
    const offenders:string[]=[];
    const walk=(dir:string)=>{for(const name of readdirSync(dir)){const path=join(dir,name);
      if(statSync(path).isDirectory())walk(path);
      else if(/\.(ts|tsx|mjs)$/.test(name)&&!/\.test\.(ts|tsx|mjs)$/.test(name)&&/segmentedRead/.test(read(path)))offenders.push(path);}};
    walk('src');walk('scripts');
    expect(offenders.sort()).toEqual(['src/server/clinical-core/owned-privacy-export-job.ts','src/server/clinical-core/owned-privacy-export.ts']);
    expect(read('src/server/clinical-core/owned-consumer-api-lambda.ts')).not.toMatch(/segmented/i);
  });

  it('reproduces the defect: one 250 KB analysis makes the whole in-app copy unobtainable; 20 KB still exports',async()=>{
    const big=analysis(250_400),fits=analysis(20_000);
    const blocked=await person(f,[{collection:'lab_analyses',payload:big},small(1),small(2)]);
    const copy=await inAppCopy(f,blocked,'blocked');
    expect(copy.manifest.recordCount).toBe(3);
    // Every record is withheld, not only the large one: the first records page already refuses.
    expect(copy.refused).toEqual({status:400,error:'request_invalid'});
    expect(copy.records).toEqual([]);
    const readable=await person(f,[{collection:'lab_analyses',payload:fits},small(1)]);
    const ok=await inAppCopy(f,readable,'blocked');
    expect(ok.refused).toBeNull();expect(ok.records).toHaveLength(2);
    expect(f.segmentCalls).toEqual([]);
  });

  it('ends a job that meets that record in one pass, failed with record_exceeds_export_page; nothing is shared and it is not reported as transient',async()=>{
    const who=await person(f,[small(1),{collection:'lab_analyses',payload:analysis(250_400)},small(2)]);
    const s=fakeStore(),jobs=jobsWith(f,s.store),handler=api(f,'blocked',s.store);
    const requested=await handler(event(who,`POST ${BASE}/job`,{body:{requestId:randomUUID()}}));
    expect(requested.statusCode).toBe(200);
    const jobId=JSON.parse(requested.body).data.jobId as string;
    // What V2's drive() receives for its first advancing poll. Before this change: 400 request_invalid, the job left
    // `running` until its 48-hour deadline, and every "Continue packaging" repeating the same refusal.
    const advanced=await handler(event(who,`GET ${BASE}/job`,{query:{jobId,advance:'true'}}));
    expect({status:advanced.statusCode,error:JSON.parse(advanced.body).error}).toEqual({status:200,error:undefined});
    const view=JSON.parse(advanced.body).data;
    expect(view).toMatchObject({status:'failed',failureCode:TOO_LARGE,readyAt:null,byteLength:null,objectChecksum:null,exportedRecords:0});
    expect(TOO_LARGE.length).toBeLessThanOrEqual(80); // V2's job schema: failureCode is a string of at most 80 characters
    // Terminal at once: the next poll is not a pass, and the job never becomes downloadable.
    await expect(jobs.advancePrivacyExportJob(context(who),{jobId},20000,new AbortController().signal)).rejects.toThrow('conflict');
    await expect(jobs.issuePrivacyExportDownload(context(who),{jobId},Date.now(),new AbortController().signal)).rejects.toThrow();
    expect(s.store.signDownload).not.toHaveBeenCalled();
    expect(s.store.uploadPart).not.toHaveBeenCalled();
    const audit=(await f.db.query<{action:string}>(`select e.action from clinical_audit.owned_privacy_export_events e
      join clinical_private.owned_privacy_export_jobs j on j.export_id=e.export_id where j.id=$1 and e.action like 'job.%' order by e.recorded_at,e.id`,[jobId])).rows.map(r=>r.action);
    expect(audit).toEqual(['job.requested','job.failed']);
    const records=(await f.db.query<{n:number}>('select count(*)::int n from clinical_core.owned_consumer_record_versions where owner_id=$1',[who])).rows[0]!.n;
    expect(records).toBe(3); // the records are unchanged
  });

  it('ends the job the same way when the record is reached on a later page of a pass',async()=>{
    // Record ids order the keyset: two analyses the deployed page can hold (one per page) come before the large one.
    const id=(first:string)=>first+randomUUID().slice(1);
    const early=[analysis(20_000),analysis(20_000)].map(a=>({...a,id:id('0')})),late={...analysis(250_400),id:id('f')};
    const who=await person(f,[...early,late].map(payload=>({collection:'lab_analyses' as const,payload})));
    const s=fakeStore(),jobs=jobsWith(f,s.store);
    const jobId=(await jobs.requestPrivacyExportJob(context(who),{requestId:randomUUID()})).jobId;
    const pages:string[]=[];
    f.hooks.before=sql=>{if(sql.includes('read_owned_privacy_export('))pages.push(sql);};
    const view=await jobs.advancePrivacyExportJob(context(who),{jobId},20000,new AbortController().signal);
    expect(view).toMatchObject({status:'failed',failureCode:TOO_LARGE});
    // Two pages read, the third refused, then the two probes (records at limit 1 with the same cursor, and consents).
    expect(pages).toHaveLength(5);
    expect(s.store.uploadPart).not.toHaveBeenCalled();expect(s.store.put).not.toHaveBeenCalled();
  });

  it('fails every records page closed if the switch is moved before the candidate is applied, and still reads consents',async()=>{
    const who=await person(f,[small(1)]);
    const reader=createOwnedPrivacyExport(runOf(f),{segmentedRead:'qualification'} as never);
    const exportId=(await reader.startPrivacyExport(context(who),{requestId:randomUUID()})).exportId;
    await expect(reader.readPrivacyExport(context(who),{exportId,section:'records',limit:25})).rejects.toThrow('storage_unavailable');
    expect((await reader.readPrivacyExport(context(who),{exportId,section:'consents',limit:25})).items).toHaveLength(2);
  });

  it('keeps every other refusal as before: a transient fault, an unreadable snapshot and a corrupted cursor leave the job running',async()=>{
    const who=await person(f,[{collection:'lab_analyses',payload:analysis(250_400)},small(1)]);
    const s=fakeStore(),jobs=jobsWith(f,s.store);
    const jobId=(await jobs.requestPrivacyExportJob(context(who),{requestId:randomUUID()})).jobId;
    const pass=()=>jobs.advancePrivacyExportJob(context(who),{jobId},20000,new AbortController().signal);
    const unlease=()=>f.db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[jobId]);
    let fault=true;
    f.hooks.before=sql=>{if(fault&&sql.includes('read_owned_privacy_export(')){fault=false;throw new Error('fictional database interruption');}};
    await expect(pass()).rejects.toThrow('storage_unavailable');
    expect(await jobs.getPrivacyExportJob(context(who),{jobId})).toMatchObject({status:'running',failureCode:null});
    f.hooks={};await unlease();
    // The snapshot (not the job) has lapsed: the consents probe is refused too, so it is not called oversized.
    const exportId=(await f.db.query<{id:string}>('select export_id id from clinical_private.owned_privacy_export_jobs where id=$1',[jobId])).rows[0]!.id;
    await f.db.query("update clinical_private.owned_privacy_exports set expires_at=clock_timestamp()-interval '1 second' where id=$1",[exportId]);
    await expect(pass()).rejects.toThrow('request_invalid');
    expect(await jobs.getPrivacyExportJob(context(who),{jobId})).toMatchObject({status:'running',failureCode:null});
    await f.db.query("update clinical_private.owned_privacy_exports set expires_at=clock_timestamp()+interval '1 hour' where id=$1",[exportId]);
    await unlease();
    // A cursor the reader itself refuses is not evidence about any record.
    await f.db.query(`update clinical_private.owned_privacy_export_jobs set cursor=jsonb_build_object('cursor',$2::text) where id=$1`,[jobId,'A'.repeat(40)]);
    await expect(pass()).rejects.toThrow('request_invalid');
    expect(await jobs.getPrivacyExportJob(context(who),{jobId})).toMatchObject({status:'running',failureCode:null});
    await jobs.cancelPrivacyExportJob(context(who),{jobId});
  });

  it('still completes a job whose records all fit the deployed page, unchanged',async()=>{
    const who=await person(f,[{collection:'lab_analyses',payload:analysis(20_000)},small(1),small(2)]);
    const s=fakeStore(),jobs=jobsWith(f,s.store);
    const jobId=(await jobs.requestPrivacyExportJob(context(who),{requestId:randomUUID()})).jobId;
    expect((await drive(jobs,jobId,who)).view).toMatchObject({status:'ready',exportedRecords:3,recordCount:3});
    await age(f,who);
    const inApp=await inAppCopy(f,who,'blocked');
    expect(JSON.stringify(s.document().records)).toBe(JSON.stringify(inApp.records));
    expect(f.segmentCalls).toEqual([]);
  });
});

describe('the BLOCKED candidate applied, with the segmented read in qualification',()=>{
  let f:Fixture;
  beforeAll(async()=>{f=await build(true);},120_000);
  afterAll(async()=>{await f?.db.close();});
  afterEach(()=>{f.hooks={};});

  it('is pinned: both file digests, the function body and its two parents',async()=>{
    expect(sha(read(CANDIDATE))).toBe(PRIVACY_EXPORT_SEGMENTS_SHA256);
    expect(sha(read(ROLLBACK))).toBe(PRIVACY_EXPORT_SEGMENTS_ROLLBACK_SHA256);
    const body=async(fn:string)=>(await f.db.query<{h:string}>("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid=to_regprocedure($1)",[fn])).rows[0]?.h;
    expect(await body(SEGMENTS)).toBe(PRIVACY_EXPORT_SEGMENTS_PROSRC.segments);
    expect(await body(DEPLOYED_READ)).toBe(PRIVACY_EXPORT_SEGMENTS_PROSRC.read);
    expect(await body(ACTOR)).toBe(PRIVACY_EXPORT_SEGMENTS_PROSRC.actor);
    expect(read(CANDIDATE)).toContain(PRIVACY_EXPORT_SEGMENTS_PROSRC.read);
    expect(read(CANDIDATE)).toContain(PRIVACY_EXPORT_SEGMENTS_PROSRC.actor);
    expect(read(ROLLBACK)).toContain(PRIVACY_EXPORT_SEGMENTS_PROSRC.segments);
    expect(read(CANDIDATE)).toMatch(/^-- UNREGISTERED, BLOCKED source candidate/);
    expect({segment:PRIVACY_EXPORT_SEGMENT_BYTES,page:PRIVACY_EXPORT_PAGE_BYTES}).toEqual({segment:15360,page:1024*1024});
    const grants=(await f.db.query<{api:boolean;pub:boolean}>("select has_function_privilege('clinical_core_api',to_regprocedure($1),'EXECUTE') api, has_function_privilege('public',to_regprocedure($1),'EXECUTE') pub",[SEGMENTS])).rows[0];
    expect(grants).toEqual({api:true,pub:false});
  });

  it('returns the 250 KB analysis whole through the in-app pages, byte-identical to the stored text and digest-checked, under the unchanged page contract',async()=>{
    const big=analysis(250_400);
    const who=await person(f,[small(1),{collection:'lab_analyses',payload:big},{...small(2),tombstone:true},small(3)]);
    f.segmentCalls.length=0;f.rowBytes.length=0;
    const copy=await inAppCopy(f,who,'qualification');
    expect(copy.refused).toBeNull();
    expect(copy.manifest).toMatchObject({version:'personal-storage-export/1',recordCount:5});
    expect(copy.records).toHaveLength(5);
    const exported=copy.records.find(r=>r.collection==='lab_analyses')!;
    const stored=await storedText(f,big.id);
    expect(stored.byteLength).toBeGreaterThan(250_000);expect(stored.byteLength).toBeLessThan(251_000);
    expect(exported.payload).toEqual(big);
    expect(JSON.stringify(exported.payload)).toBe(JSON.stringify(JSON.parse(stored.toString('utf8'))));
    // The segments the service sent, concatenated, are the stored octets; their digest is the one each segment carried.
    const segments=f.segmentCalls.flatMap(text=>JSON.parse(text).items).filter((s:{recordId:string})=>s.recordId===big.id);
    expect(segments.map((s:{segment:number})=>s.segment)).toEqual([...Array(Math.ceil(stored.byteLength/15360)).keys()]);
    const joined=Buffer.concat(segments.map((s:{data:string})=>Buffer.from(s.data,'base64')));
    expect(Buffer.compare(joined,stored)).toBe(0);
    expect(new Set(segments.map((s:{payloadSha256:string})=>s.payloadSha256))).toEqual(new Set([sha(stored)]));
    // At least one boundary falls inside a multi-byte character, so reassembly is by bytes, not text.
    expect(segments.slice(1).some((_:unknown,i:number)=>(stored[(i+1)*15360]!&0xc0)===0x80)).toBe(true);
    const tombstone=copy.records.filter(r=>r.deleted===true);
    expect(tombstone).toHaveLength(1);expect(tombstone[0]!.payload).toEqual({});
    // Each database row stays under the deployed 24 KiB page bound (the Data API's 64 KiB row limit is a hosted hold).
    expect(Math.max(...f.rowBytes)).toBeLessThan(DATA_API_ROW_BYTES/2);
    for(const page of copy.pages)expect(page.responseBytes).toBeLessThan(2*1024*1024); // V2's response bound
  });

  it('returns whole records under the per-page byte budget, never splitting one across pages',async()=>{
    const who=await person(f,[0,1,2,3,4,5].map(()=>({collection:'lab_analyses' as const,payload:analysis(250_400)})));
    const copy=await inAppCopy(f,who,'qualification');
    expect(copy.refused).toBeNull();expect(copy.records).toHaveLength(6);
    const recordPages=copy.pages.slice(0,copy.pages.length-1);
    expect(recordPages.length).toBeGreaterThanOrEqual(2);
    for(const page of recordPages)expect(page.items===1||page.bytes<=PRIVACY_EXPORT_PAGE_BYTES).toBe(true);
    for(const record of copy.records)expect(Buffer.byteLength(JSON.stringify(record.payload))).toBeGreaterThan(240_000);
  });

  it('for records the deployed reader can page, returns exactly what it returns',async()=>{
    const who=await person(f,[{collection:'lab_analyses',payload:analysis(20_000)},...[1,2,3,4,5,6].map(i=>small(i)),{...small(7),tombstone:true}]);
    const blocked=await inAppCopy(f,who,'blocked');
    const segmentedReader=createOwnedPrivacyExport(runOf(f),{segmentedRead:'qualification'} as never);
    const records:unknown[]=[];let cursor:string|undefined;
    for(;;){const page=await segmentedReader.readPrivacyExport(context(who),{exportId:blocked.manifest.exportId,section:'records',limit:3,...(cursor?{cursor}:{})});
      records.push(...page.items);if(!page.nextCursor)break;cursor=page.nextCursor;}
    expect(blocked.refused).toBeNull();
    expect(JSON.stringify(records)).toBe(JSON.stringify(blocked.records));
  });

  it('packages the 250 KB analysis through advancePrivacyExportJob into a ready copy whose records equal the in-app copy',async()=>{
    const big=analysis(250_400);
    const who=await person(f,[{collection:'lab_analyses',payload:big},small(1),small(2)]);
    const s=fakeStore(),jobs=jobsWith(f,s.store,'qualification');
    const jobId=(await jobs.requestPrivacyExportJob(context(who),{requestId:randomUUID()})).jobId;
    const {view}=await drive(jobs,jobId,who);
    expect(view).toMatchObject({status:'ready',recordCount:3,exportedRecords:3,failureCode:null});
    const link=await jobs.issuePrivacyExportDownload(context(who),{jobId},Date.now(),new AbortController().signal);
    expect(link.byteLength).toBe(view.byteLength);
    const document=s.document();
    expect(document.manifest).toMatchObject({version:'personal-storage-export/1',recordCount:3});
    const packaged=document.records.find((r:{collection:string})=>r.collection==='lab_analyses');
    expect(packaged.payload).toEqual(big);
    expect(sha(JSON.stringify(JSON.parse((await storedText(f,big.id)).toString('utf8'))))).toBe(sha(JSON.stringify(packaged.payload)));
    await age(f,who);
    const inApp=await inAppCopy(f,who,'qualification');
    expect(JSON.stringify(document.records)).toBe(JSON.stringify(inApp.records));
  });

  it('never puts owner B\'s records in owner A\'s copy, and refuses B on A\'s snapshot at the database',async()=>{
    const a=await person(f,[{collection:'lab_analyses',payload:analysis(250_400,'OWNER-A-ONLY')},small(1,'OWNER-A-ONLY')]);
    const b=await person(f,[{collection:'lab_analyses',payload:analysis(250_400,'OWNER-B-ONLY')},small(1,'OWNER-B-ONLY')]);
    const copy=await inAppCopy(f,a,'qualification');
    expect(copy.refused).toBeNull();
    expect(markers(JSON.stringify(copy.records))).toEqual(new Set(['OWNER-A-ONLY']));
    const s=fakeStore(),jobs=jobsWith(f,s.store,'qualification');
    const jobId=(await jobs.requestPrivacyExportJob(context(a),{requestId:randomUUID()})).jobId;
    expect((await drive(jobs,jobId,a)).view.status).toBe('ready');
    expect(markers(JSON.stringify(s.document()))).toEqual(new Set(['OWNER-A-ONLY']));
    // B presenting A's export id, at the segmented function itself and through the reader.
    await expect(asOwner(f,b,'select clinical_core.read_owned_privacy_export_segments($1,100,null) as result',[copy.manifest.exportId],'consent_management'))
      .rejects.toThrow('privacy_export_request_invalid');
    const reader=createOwnedPrivacyExport(runOf(f),{segmentedRead:'qualification'} as never);
    await expect(reader.readPrivacyExport(context(b),{exportId:copy.manifest.exportId,section:'records',limit:25})).rejects.toThrow('request_invalid');
    // And with the wrong purpose, even for A.
    await expect(asOwner(f,a,'select clinical_core.read_owned_privacy_export_segments($1,100,null) as result',[copy.manifest.exportId],'clinical_data'))
      .rejects.toThrow('privacy_export_request_invalid');
  });

  it('fails a page closed on a changed, reordered, truncated or mislabelled segment: nothing partial is returned',async()=>{
    const big=analysis(250_400);
    const who=await person(f,[{collection:'lab_analyses',payload:big},small(1)]);
    const reader=createOwnedPrivacyExport(runOf(f),{segmentedRead:'qualification'} as never);
    const exportId=(await reader.startPrivacyExport(context(who),{requestId:randomUUID()})).exportId;
    const page=()=>reader.readPrivacyExport(context(who),{exportId,section:'records',limit:25});
    const edit=(change:(value:{items:Record<string,unknown>[];next:unknown},call:number)=>void)=>{let call=0;
      f.hooks.rows=(sql,rows)=>{if(!sql.includes('read_owned_privacy_export_segments'))return rows;
        const value=JSON.parse(String(rows[0]!.result));change(value,call++);return [{result:JSON.stringify(value)}];};};
    const flip=(data:string)=>data.slice(0,100)+(data[100]==='A'?'B':'A')+data.slice(101); // still valid base64, other bytes
    const cases:Array<[string,(value:{items:Record<string,unknown>[];next:unknown},call:number)=>void]>=[
      ['changed bytes',(v,call)=>{if(call===3)v.items[0]!.data=flip(String(v.items[0]!.data));}],
      ['a different digest on one segment',(v,call)=>{if(call===2)v.items[0]!.payloadSha256='0'.repeat(64);}],
      ['a skipped segment',(v,call)=>{if(call===4)v.items[0]!.segment=Number(v.items[0]!.segment)+1;}],
      ['a short segment',(v,call)=>{if(call===1)v.items[0]!.data=String(v.items[0]!.data).slice(0,-4);}],
      ['a record cut short',(v,call)=>{if(call===5){v.items=[];v.next=null;}}],
      ['a non-progressing cursor',(v,call)=>{if(call===1)v.items=[];}],
      ['an extra field',(v,call)=>{if(call===0)v.items[0]!.ownerId=who;}],
      ['a size above the store limit',(v,call)=>{if(call===0)v.items[0]!.payloadBytes=300_000;}],
      ['line-broken base64',(v,call)=>{if(call===0)v.items[0]!.data=String(v.items[0]!.data).slice(0,76)+'\n'+String(v.items[0]!.data).slice(76);}],
    ];
    for(const [name,change] of cases){
      edit(change);
      await expect(page(),name).rejects.toThrow('storage_unavailable');
    }
    f.hooks={};
    expect((await page()).items.map(r=>r.collection)).toEqual(['lab_analyses','wellness_profiles']);
  });

  it('shares nothing from a cancelled or partial job',async()=>{
    const who=await person(f,[{collection:'lab_analyses',payload:analysis(250_400)},{collection:'lab_analyses',payload:analysis(250_400)},small(1)]);
    const s=fakeStore(),jobs=jobsWith(f,s.store,'qualification');
    const jobId=(await jobs.requestPrivacyExportJob(context(who),{requestId:randomUUID()})).jobId;
    const partial=await jobs.advancePrivacyExportJob(context(who),{jobId},20000,new AbortController().signal);
    // One part of the document is in the store; the job is not finished.
    expect(partial).toMatchObject({status:'running',readyAt:null,parts:1,byteLength:null});
    expect(s.uploads.size).toBe(1);
    await expect(jobs.issuePrivacyExportDownload(context(who),{jobId},Date.now(),new AbortController().signal)).rejects.toThrow();
    await jobs.cancelPrivacyExportJob(context(who),{jobId});
    await expect(jobs.issuePrivacyExportDownload(context(who),{jobId},Date.now(),new AbortController().signal)).rejects.toThrow();
    expect(s.store.signDownload).not.toHaveBeenCalled();
    await f.db.query('update clinical_private.owned_privacy_export_jobs set lease_until=null where id=$1',[jobId]);
    expect(await jobs.cleanupPrivacyExportJobs(context(who),new AbortController().signal)).toEqual({cleaned:1,remaining:0});
    expect(s.uploads.size).toBe(0);expect([...s.objects.values()].every(v=>v.size===0)).toBe(true);
  });
});

describe('the candidate\'s guards and its preserving rollback',()=>{
  let db:PGlite;
  beforeAll(async()=>{db=(await build(true)).db;},120_000);
  afterAll(async()=>{await db?.close();});
  const present=async()=>(await db.query<{fn:string|null}>('select to_regprocedure($1)::text fn',[SEGMENTS])).rows[0]!.fn;
  const deployedBody=async()=>(await db.query<{h:string}>("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid=to_regprocedure($1)",[DEPLOYED_READ])).rows[0]!.h;

  it('refuses a second application, rolls back only its own function keeping its audit rows, and reapplies cleanly',async()=>{
    const f:Fixture={db,hooks:{},rowBytes:[],segmentCalls:[]};
    const who=await person(f,[{collection:'lab_analyses',payload:analysis(40_000)}]);
    const reader=createOwnedPrivacyExport(runOf(f),{segmentedRead:'qualification'} as never);
    const exportId=(await reader.startPrivacyExport(context(who),{requestId:randomUUID()})).exportId;
    expect((await reader.readPrivacyExport(context(who),{exportId,section:'records',limit:25})).items).toHaveLength(1);
    const audits=async()=>(await db.query<{n:number}>("select count(*)::int n from clinical_audit.owned_privacy_export_events where export_id=$1 and action='records.read'",[exportId])).rows[0]!.n;
    const before=await audits();expect(before).toBeGreaterThanOrEqual(3);
    await expect(db.exec(read(CANDIDATE))).rejects.toThrow('privacy_export_segments_parent_refused');
    await db.exec('rollback');
    const body=await deployedBody();
    await db.exec(read(ROLLBACK));
    expect(await present()).toBeNull();
    expect(await audits()).toBe(before);
    expect(await deployedBody()).toBe(body);
    await db.exec(read(CANDIDATE));
    expect(await present()).toContain('read_owned_privacy_export_segments');
  });

  it('refuses to roll back a drifted body, and refuses to apply over a drifted parent',async()=>{
    await db.exec(`create or replace function clinical_core.read_owned_privacy_export_segments(_export_id uuid,_limit integer,_after jsonb default null)
      returns jsonb language plpgsql security definer set search_path='' as $$ begin return '{}'::jsonb; end $$`);
    await expect(db.exec(read(ROLLBACK))).rejects.toThrow('privacy_export_segments_rollback_refused');
    await db.exec('rollback');
    expect(await present()).toContain('read_owned_privacy_export_segments');
    await db.exec(`drop function ${SEGMENTS}`);
    const original=(await db.query<{def:string}>('select pg_get_functiondef(to_regprocedure($1)) def',[DEPLOYED_READ])).rows[0]!.def;
    await db.exec(original.replace("_bytes integer:=2;","_bytes integer:=3;"));
    await expect(db.exec(read(CANDIDATE))).rejects.toThrow('privacy_export_segments_parent_refused');
    await db.exec('rollback');
    expect(await present()).toBeNull();
  });
});
