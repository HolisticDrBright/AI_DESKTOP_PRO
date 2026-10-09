import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {EXTERNAL_CALENDAR_ACK,type ExternalCalendarRequest} from '../../contracts/externalCalendar';
import {createExternalCalendarConnections,ExternalCalendarError} from './external-calendar-connections';
import {openCalendarToken,sealCalendarToken} from '../calendar/externalCalendarTransport';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {SyntheticRequestContext} from './aws-identity-consent';

const id=(n:number)=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),otherOrg=id(2),clinician=id(3),colleague=id(4),outside=id(5),consumer=id(6);
const READ_SCOPE='https://www.googleapis.com/auth/calendar.readonly';
const FREEBUSY_SCOPE='https://www.googleapis.com/auth/calendar.freebusy';
const WRITE_SCOPE='https://www.googleapis.com/auth/calendar';
let db:PGlite;
const context=(actor=clinician,organization=org,pool:'consumer'|'workforce'='workforce'):SyntheticRequestContext=>({
 actorPersonId:actor,organizationId:organization,identityPool:pool,identitySubject:'subject-'+actor,
 purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false});
// Mirror the deployed driver, which classifies by SQL error name rather than SQLSTATE.
const REQUEST_INVALID=/\bexternal_calendar_invalid\b/;
const FORBIDDEN=/\bexternal_calendar_forbidden\b/;
const REFUSED=/\b(external_calendar_scope_refused|external_calendar_immutable|external_calendar_absent)\b/;
const CONFLICT=/\b(external_calendar_not_pending|external_calendar_state_mismatch|external_calendar_authorization_expired|external_calendar_revision_stale|external_calendar_not_connected|external_calendar_reauthorization_required)\b/;
function classify(cause:unknown):'request_invalid'|'identity_refused'|'operation_refused'|'conflict'{
 const message=cause instanceof Error?cause.message:String(cause);
 if(REQUEST_INVALID.test(message))return 'request_invalid';
 if(FORBIDDEN.test(message))return 'identity_refused';
 if(CONFLICT.test(message))return 'conflict';
 if(REFUSED.test(message))return 'operation_refused';
 return 'operation_refused';
}
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){throw new ClinicalCoreDatabaseRejection(classify(cause));}
 }});
})};
const call=(input:ExternalCalendarRequest,actor=clinician,organization=org,pool:'consumer'|'workforce'='workforce')=>
 createExternalCalendarConnections(database)(context(actor,organization,pool),input);

const digestOf=(value:string)=>createHash('sha256').update(value).digest('hex');
const key=randomBytes(32);
const envelope=(connectionId:string,token:string)=>{
 const sealed=sealCalendarToken(key,connectionId,token);
 if(!sealed.ok)throw new Error(sealed.refusal);
 return {ciphertext:sealed.value.ciphertext,iv:sealed.value.iv,tag:sealed.value.tag};
};

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional A'),($2,'Fictional B')",[org,otherOrg]);
 for(const [person,pool] of [[clinician,'workforce'],[colleague,'workforce'],[outside,'workforce'],[consumer,'consumer']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($1,$3,'practitioner'),($4,$5,'practitioner')",
  [org,clinician,colleague,otherOrg,outside]);
},60000);
afterAll(async()=>{await db?.close();});

async function beginFor(actor=clinician,organization=org,state='state-'+randomBytes(24).toString('hex'),scopes=[READ_SCOPE,FREEBUSY_SCOPE]){
 // The verifier is sealed to a connection that does not exist yet, so it is sealed to
 // a placeholder and re-sealed once the row has an id. The real route does the same.
 const started=await call({action:'begin',stateDigest:digestOf(state),scopes,
  verifier:envelope('00000000-0000-4000-8000-000000000000','verifier-value')},actor,organization);
 if(started.action!=='begin')throw new Error('unexpected');
 return {state,...started};
}

describe('external calendar connections: real adapter and PostgreSQL, not hosted AWS',()=>{
 it('declares its contract version',()=>{expect(EXTERNAL_CALENDAR_ACK).toBe('external-calendar/1');});

 it('reports no connection before one exists, without inventing a row',async()=>{
  const read=await call({action:'read'},colleague);
  expect(read).toEqual({action:'read',state:'disconnected',connected:false});
 });

 it('carries an authorization from begin through complete, material and disconnect',async()=>{
  const started=await beginFor();
  const pending=await call({action:'pending',stateDigest:digestOf(started.state)});
  expect(pending.action).toBe('pending');
  if(pending.action!=='pending')return;
  expect(pending.verifier.connectionId).toBe(started.connectionId);
  expect(pending.scopes).toEqual([READ_SCOPE,FREEBUSY_SCOPE]);

  const pendingRead=await call({action:'read'});
  expect(pendingRead).toMatchObject({action:'read',state:'pending_authorization',connected:false,hasRefreshToken:false});

  const refresh=envelope(started.connectionId,'refresh-token-value');
  const completed=await call({action:'complete',expectedRevision:pending.revision,scopes:[READ_SCOPE,FREEBUSY_SCOPE],
   refresh,expiresAt:'2026-10-01T12:00:00.000Z'});
  expect(completed).toMatchObject({action:'complete',state:'connected',connectionId:started.connectionId});

  const material=await call({action:'material'});
  expect(material.action).toBe('material');
  if(material.action!=='material')return;
  expect(material.refresh.connectionId).toBe(started.connectionId);
  // The envelope survived storage and still opens to the same token for this connection.
  expect(openCalendarToken(key,started.connectionId,material.refresh)).toEqual({ok:true,value:'refresh-token-value'});

  const gone=await call({action:'disconnect',expectedRevision:material.revision});
  expect(gone).toMatchObject({action:'disconnect',state:'disconnected',hasRefreshToken:false});
  const afterDisconnect=await call({action:'read'});
  expect(afterDisconnect).toMatchObject({state:'disconnected',connected:false,hasRefreshToken:false,calendarIds:[]});
  // Disconnect is erasure: there is no longer any material to hand out.
  await expect(call({action:'material'})).rejects.toMatchObject({category:'conflict'});
 });

 it('refuses a write scope at begin and at complete, so neither path can widen it',async()=>{
  await expect(call({action:'begin',stateDigest:digestOf('x'.repeat(40)),scopes:[WRITE_SCOPE],
   verifier:envelope(id(9),'verifier-value')},colleague)).rejects.toMatchObject({category:'identity_refused'});
  const started=await beginFor(colleague,org);
  const pending=await call({action:'pending',stateDigest:digestOf(started.state)},colleague);
  if(pending.action!=='pending')throw new Error('unexpected');
  await expect(call({action:'complete',expectedRevision:pending.revision,scopes:[WRITE_SCOPE],
   refresh:envelope(started.connectionId,'refresh-token-value'),expiresAt:'2026-10-01T12:00:00.000Z'},colleague))
   .rejects.toMatchObject({category:'identity_refused'});
 });

 it('answers a mismatched or stale authorization state with a conflict, never with the material',async()=>{
  const started=await beginFor(outside,otherOrg);
  await expect(call({action:'pending',stateDigest:digestOf('a different state entirely')},outside,otherOrg))
   .rejects.toMatchObject({category:'conflict'});
  await db.query("update clinical_core.external_calendar_connections set authorization_started_at=now()-interval '20 minutes',revision=revision+1 where id=$1",[started.connectionId]);
  await expect(call({action:'pending',stateDigest:digestOf(started.state)},outside,otherOrg))
   .rejects.toMatchObject({category:'conflict'});
 });

 it('refuses a stale revision on every mutation that names one',async()=>{
  const started=await beginFor();
  const pending=await call({action:'pending',stateDigest:digestOf(started.state)});
  if(pending.action!=='pending')throw new Error('unexpected');
  await expect(call({action:'complete',expectedRevision:'99',scopes:[READ_SCOPE],
   refresh:envelope(started.connectionId,'refresh-token-value'),expiresAt:'2026-10-01T12:00:00.000Z'}))
   .rejects.toMatchObject({category:'conflict'});
 });

 it('drops the refresh token in the same statement that records a revocation',async()=>{
  const started=await beginFor();
  const pending=await call({action:'pending',stateDigest:digestOf(started.state)});
  if(pending.action!=='pending')throw new Error('unexpected');
  const completed=await call({action:'complete',expectedRevision:pending.revision,scopes:[READ_SCOPE],
   refresh:envelope(started.connectionId,'refresh-token-value'),expiresAt:'2026-10-01T12:00:00.000Z'});
  if(completed.action!=='complete')throw new Error('unexpected');
  const revoked=await call({action:'record_state',expectedRevision:completed.revision,state:'revoked'});
  expect(revoked).toMatchObject({action:'record_state',state:'revoked',hasRefreshToken:false});
  await expect(call({action:'material'})).rejects.toMatchObject({category:'conflict'});
  const [row]=(await db.query<{refresh_ciphertext:string|null;access_expires_at:string|null}>(
   'select refresh_ciphertext,access_expires_at from clinical_core.external_calendar_connections where id=$1',[started.connectionId])).rows;
  expect(row.refresh_ciphertext).toBeNull();
  expect(row.access_expires_at).toBeNull();
 });

 it('keeps an expired connection usable for a refresh, because it still holds one',async()=>{
  const started=await beginFor();
  const pending=await call({action:'pending',stateDigest:digestOf(started.state)});
  if(pending.action!=='pending')throw new Error('unexpected');
  const completed=await call({action:'complete',expectedRevision:pending.revision,scopes:[READ_SCOPE],
   refresh:envelope(started.connectionId,'refresh-token-value'),expiresAt:'2026-10-01T12:00:00.000Z'});
  if(completed.action!=='complete')throw new Error('unexpected');
  const expired=await call({action:'record_state',expectedRevision:completed.revision,state:'expired'});
  expect(expired).toMatchObject({state:'expired',hasRefreshToken:true});
  const material=await call({action:'material'});
  expect(material.action).toBe('material');
 });

 it('bounds the calendar list it will store',async()=>{
  const started=await beginFor();
  const pending=await call({action:'pending',stateDigest:digestOf(started.state)});
  if(pending.action!=='pending')throw new Error('unexpected');
  const completed=await call({action:'complete',expectedRevision:pending.revision,scopes:[READ_SCOPE],
   refresh:envelope(started.connectionId,'refresh-token-value'),expiresAt:'2026-10-01T12:00:00.000Z'});
  if(completed.action!=='complete')throw new Error('unexpected');
  const set=await call({action:'set_calendars',expectedRevision:completed.revision,calendarIds:['a@example.com','b@example.com']});
  expect(set).toMatchObject({action:'set_calendars',calendarIds:['a@example.com','b@example.com']});
  // Eleven is refused by the contract before it reaches SQL, which is the cheaper refusal.
  await expect(call({action:'set_calendars',expectedRevision:'99',
   calendarIds:Array.from({length:11},(_unused,index)=>`c${index}@example.com`)}))
   .rejects.toMatchObject({category:'request_invalid'});
 });

 it('never shows one practitioner another practitioner\'s connection',async()=>{
  const mine=await beginFor();
  const theirs=await call({action:'read'},colleague);
  expect(theirs.action).toBe('read');
  if(theirs.action!=='read')return;
  expect(theirs.connectionId).not.toBe(mine.connectionId);
  // And the colleague cannot read the pending material by knowing the state.
  await expect(call({action:'pending',stateDigest:digestOf(mine.state)},colleague))
   .rejects.toMatchObject({category:'conflict'});
 });

 it('refuses a consumer caller and an unknown action',async()=>{
  await expect(call({action:'read'},consumer,org,'consumer')).rejects.toBeInstanceOf(ExternalCalendarError);
  await expect(call({action:'read'},consumer,org,'consumer')).rejects.toMatchObject({category:'identity_refused'});
  await expect(call({action:'wander'} as never)).rejects.toMatchObject({category:'request_invalid'});
 });

 it('denies the API role any direct reach into the connection or audit tables',async()=>{
  for(const table of ['external_calendar_connections','external_calendar_audit']){
   await expect(db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query(`select * from clinical_core.${table} limit 1`);
   })).rejects.toBeTruthy();
  }
 });

 it('will not let a row be edited into claiming a different owner',async()=>{
  const started=await beginFor();
  await expect(db.query('update clinical_core.external_calendar_connections set practitioner_id=$1,revision=revision+1 where id=$2',
   [colleague,started.connectionId])).rejects.toMatchObject({message:expect.stringContaining('external_calendar_immutable')});
 });
});
