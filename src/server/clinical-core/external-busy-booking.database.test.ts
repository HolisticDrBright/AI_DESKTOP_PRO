import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {createExternalCalendarConnections} from './external-calendar-connections';
import {sealCalendarToken} from '../calendar/externalCalendarTransport';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {ExternalCalendarRequest} from '../../contracts/externalCalendar';
import type {SyntheticRequestContext} from './aws-identity-consent';

/**
 * Booking against a practitioner's external calendar.
 *
 * The connector could read busy time and nothing consulted it: the booking function
 * checked internal appointments only, so a practitioner could connect a calendar, see
 * "Connected", and be booked over anyway. These assertions are about the four answers the
 * stored check can give, and in particular about the two that refuse without a conflict —
 * because "we cannot currently tell" must not be answered as "free".
 */
const id=(n:number)=>'60000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2),colleague=id(3),patient=id(4);
const READ_SCOPE='https://www.googleapis.com/auth/calendar.readonly';
const key=randomBytes(32);
let db:PGlite;

const context=(actor=clinician):SyntheticRequestContext=>({
 actorPersonId:actor,organizationId:org,identityPool:'workforce',identitySubject:'subject-'+actor,
 purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',
 containsPhi:false,realPatientData:false});
const INVALID=/\bexternal_calendar_invalid\b/,FORBIDDEN=/\bexternal_calendar_forbidden\b/;
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){
   const message=cause instanceof Error?cause.message:String(cause);
   throw new ClinicalCoreDatabaseRejection(INVALID.test(message)?'request_invalid'
    :FORBIDDEN.test(message)?'identity_refused':'conflict');
  }
 }});
})};
const call=(input:ExternalCalendarRequest,actor=clinician)=>
 createExternalCalendarConnections(database)(context(actor),input);

const WINDOW={from:'2026-10-05T00:00:00.000Z',to:'2026-10-06T00:00:00.000Z'};
const SLOT={from:'2026-10-05T09:00:00.000Z',to:'2026-10-05T10:00:00.000Z'};

/** Booking runs as the real RPC, with the practitioner's own request context. */
async function book(actor=clinician,slot=SLOT){
 return db.transaction(async tx=>{
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',
   [actor,org,'workforce','subject-'+actor,'clinical_data','synthetic-staging','synthetic_only']);
  return tx.query<{data:Record<string,unknown>}>(
   'select clinical_core.book_appointment($1,$2,$3,$4::timestamptz,$5::timestamptz,$6) as data',
   [org,actor,'follow-up',slot.from,slot.to,patient]);
 });
}
async function connect(actor=clinician){
 const state='state-'+randomBytes(24).toString('hex');
 const digest=createHash('sha256').update(state).digest('hex');
 const verifier=sealCalendarToken(key,digest,'v'.repeat(64));
 if(!verifier.ok)throw new Error(verifier.refusal);
 const begun=await call({action:'begin',stateDigest:digest,scopes:[READ_SCOPE],
  verifier:{ciphertext:verifier.value.ciphertext,iv:verifier.value.iv,tag:verifier.value.tag}},actor);
 if(begun.action!=='begin')throw new Error('unexpected');
 const pending=await call({action:'pending',stateDigest:digest},actor);
 if(pending.action!=='pending')throw new Error('unexpected');
 const refresh=sealCalendarToken(key,begun.connectionId,'refresh-token-value');
 if(!refresh.ok)throw new Error(refresh.refusal);
 const done=await call({action:'complete',expectedRevision:pending.revision,scopes:[READ_SCOPE],
  refresh:{ciphertext:refresh.value.ciphertext,iv:refresh.value.iv,tag:refresh.value.tag},
  expiresAt:'2026-10-05T12:00:00.000Z'},actor);
 if(done.action!=='complete')throw new Error('unexpected');
 return done.connectionId;
}
const sync=(busy:Array<{start:string;end:string}>,unavailableCalendars=0,actor=clinician)=>
 call({action:'busy_sync',windowFrom:WINDOW.from,windowTo:WINDOW.to,busy,unavailableCalendars},actor);

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional A')",[org]);
 for(const person of [clinician,colleague]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)",[person,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($1,$3,'practitioner')",[org,clinician,colleague]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_busy_00001')",[patient,org]);
},60000);
afterAll(async()=>{await db?.close();});

beforeEach(async()=>{
 await db.exec(`set session_replication_role = 'replica';
  delete from clinical_core.external_calendar_busy_blocks;
  delete from clinical_core.external_calendar_busy_windows;
  delete from clinical_core.external_calendar_audit;
  delete from clinical_core.external_calendar_connections;
  delete from clinical_audit.events;
  delete from clinical_core.appointments;
  set session_replication_role = 'origin';`);
});

describe('booking with no external calendar',()=>{
 it('is unaffected: there is nothing to respect',async()=>{
  const result=await book();
  expect(result.rows[0]!.data).toMatchObject({status:'scheduled'});
 });
});

describe('booking with a connected calendar',()=>{
 it('proceeds when a fresh, complete sync says the time is free',async()=>{
  await connect();
  const synced=await sync([{start:'2026-10-05T14:00:00.000Z',end:'2026-10-05T15:00:00.000Z'}]);
  expect(synced).toMatchObject({action:'busy_sync',stored:1,complete:true,unavailableCalendars:0});
  const result=await book();
  expect(result.rows[0]!.data).toMatchObject({status:'scheduled'});
 });

 it('refuses when the stored busy time overlaps the slot',async()=>{
  await connect();
  await sync([{start:'2026-10-05T09:30:00.000Z',end:'2026-10-05T10:30:00.000Z'}]);
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_conflict')});
  const count=await db.query<{n:string}>('select count(*)::text as n from clinical_core.appointments');
  expect(count.rows[0]!.n).toBe('0');
 });

 it('refuses when nothing has been synced, because unknown is not free',async()=>{
  await connect();
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_unknown')});
 });

 it('refuses when the only sync is older than the freshness bound',async()=>{
  await connect();
  await sync([]);
  await db.exec(`set session_replication_role='replica';
   update clinical_core.external_calendar_busy_windows set synced_at=now()-interval '2 hours';
   set session_replication_role='origin';`);
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_stale')});
 });

 it('refuses when the sync could not answer for every calendar',async()=>{
  await connect();
  // A window with an unreadable calendar is not a complete answer, so it covers nothing.
  await sync([],1);
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_unknown')});
 });

 it('refuses when the sync covers a different window than the slot',async()=>{
  await connect();
  await sync([]);
  await expect(book(clinician,{from:'2026-10-07T09:00:00.000Z',to:'2026-10-07T10:00:00.000Z'}))
   .rejects.toMatchObject({message:expect.stringContaining('external_busy_unknown')});
 });

 it('refuses while a re-authorization is in flight, even though the old sync is still there',async()=>{
  await connect();
  await sync([]);
  // Re-authorizing is a legitimate way into pending_authorization, and it drops the
  // refresh token. The stored busy time is still sitting there, and it must not be
  // treated as a current answer while the connection cannot be read.
  const state='state-'+randomBytes(24).toString('hex');
  const digest=createHash('sha256').update(state).digest('hex');
  const verifier=sealCalendarToken(key,digest,'v'.repeat(64));
  if(!verifier.ok)throw new Error(verifier.refusal);
  await call({action:'begin',stateDigest:digest,scopes:[READ_SCOPE],
   verifier:{ciphertext:verifier.value.ciphertext,iv:verifier.value.iv,tag:verifier.value.tag}});
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_unreadable')});
 });

 it('refuses after the provider revoked the authorization',async()=>{
  await connect();
  await sync([]);
  const read=await call({action:'read'});
  if(read.action!=='read'||!read.revision)throw new Error('unexpected');
  const revoked=await call({action:'record_state',expectedRevision:read.revision,state:'revoked'});
  expect(revoked).toMatchObject({state:'revoked',hasRefreshToken:false});
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_unreadable')});
 });

 it('is unaffected again once the calendar is disconnected',async()=>{
  const connectionId=await connect();
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_unknown')});
  const read=await call({action:'read'});
  if(read.action!=='read'||!read.revision)throw new Error('unexpected');
  await call({action:'disconnect',expectedRevision:read.revision});
  const after=await db.query<{state:string}>('select state from clinical_core.external_calendar_connections where id=$1',[connectionId]);
  expect(after.rows[0]!.state).toBe('disconnected');
  const result=await book();
  expect(result.rows[0]!.data).toMatchObject({status:'scheduled'});
 });

 it('only respects the calendar of the practitioner being booked',async()=>{
  await connect(colleague);
  // The colleague's unsynced connection must not block a booking for someone else.
  const result=await book(clinician);
  expect(result.rows[0]!.data).toMatchObject({status:'scheduled'});
 });

 it('replaces a window whole, so a removed meeting does not linger',async()=>{
  await connect();
  await sync([{start:'2026-10-05T09:30:00.000Z',end:'2026-10-05T10:30:00.000Z'}]);
  await expect(book()).rejects.toMatchObject({message:expect.stringContaining('external_busy_conflict')});
  await sync([]);
  const result=await book();
  expect(result.rows[0]!.data).toMatchObject({status:'scheduled'});
 });

 it('clamps a provider interval to the window it was read for',async()=>{
  await connect();
  await sync([{start:'2026-10-01T00:00:00.000Z',end:'2026-10-31T00:00:00.000Z'}]);
  const [row]=(await db.query<{starts_at:string;ends_at:string}>(
   'select starts_at,ends_at from clinical_core.external_calendar_busy_blocks')).rows;
  expect(new Date(row!.starts_at).toISOString()).toBe(WINDOW.from);
  expect(new Date(row!.ends_at).toISOString()).toBe(WINDOW.to);
 });
});

describe('the sync itself',()=>{
 it('refuses a window that is absurd, unbounded or not the caller\'s',async()=>{
  await connect();
  await expect(call({action:'busy_sync',windowFrom:WINDOW.to,windowTo:WINDOW.from,busy:[],unavailableCalendars:0}))
   .rejects.toMatchObject({category:'request_invalid'});
  await expect(call({action:'busy_sync',windowFrom:'2026-01-01T00:00:00.000Z',windowTo:'2026-06-01T00:00:00.000Z',busy:[],unavailableCalendars:0}))
   .rejects.toMatchObject({category:'request_invalid'});
  // The colleague has no connection of their own to sync.
  await expect(sync([],0,colleague)).rejects.toMatchObject({category:'conflict'});
 });

 it('refuses to store busy time for a connection that is not readable',async()=>{
  const connectionId=await connect();
  await db.query("update clinical_core.external_calendar_connections set state='revoked',revision=revision+1 where id=$1",[connectionId]);
  await expect(sync([])).rejects.toMatchObject({category:'conflict'});
 });

 it('records the sync in the content-free audit',async()=>{
  await connect();
  await sync([{start:'2026-10-05T14:00:00.000Z',end:'2026-10-05T15:00:00.000Z'}]);
  const rows=await db.query<{action:string}>("select action from clinical_core.external_calendar_audit where action='busy_synced'");
  expect(rows.rows).toHaveLength(1);
 });

 it('stores an interval and nothing else about the meeting',async()=>{
  await connect();
  await sync([{start:'2026-10-05T14:00:00.000Z',end:'2026-10-05T15:00:00.000Z'}]);
  const columns=await db.query<{column_name:string}>(
   "select column_name from information_schema.columns where table_name='external_calendar_busy_blocks'");
  const names=columns.rows.map(row=>row.column_name).sort();
  // No title, no attendees, no location, no description — there is nowhere to put one.
  expect(names).toEqual(['connection_id','ends_at','id','organization_id','practitioner_id',
   'starts_at','synced_at','window_from','window_to']);
 });
});
