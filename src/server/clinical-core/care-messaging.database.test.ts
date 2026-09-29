import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {careMessageResponse,parseCareMessageResponse,MESSAGE_ACK,type CareMessageRequest} from '../../contracts/careMessages';
import {createCareMessaging} from './care-messaging';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {SyntheticRequestContext} from './aws-identity-consent';
const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),otherOrg=id(2),owner=id(3),other=id(4),clinician=id(5),patient=id(6),connection=id(7),outside=id(8),admin=id(9);
let db:PGlite,serial=100;
const context=(actor=owner,organization=org,pool:'consumer'|'workforce'='consumer'):SyntheticRequestContext=>({
 actorPersonId:actor,organizationId:organization,identityPool:pool,identitySubject:'subject-'+actor,
 purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false});
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
 await tx.exec('set local role clinical_core_api');
 return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
  try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
  catch(cause){throw new ClinicalCoreDatabaseRejection(cause&&typeof cause==='object'&&'code' in cause&&cause.code==='40001'?'conflict':'operation_refused');}
 }});
})};
const request=(input:CareMessageRequest,actor=owner,organization=org,pool:'consumer'|'workforce'='consumer')=>createCareMessaging(database)(context(actor,organization,pool),input);
const command=():CareMessageRequest=>({action:'send',connectionId:connection,requestId:id(++serial),subject:'Fictional program question',body:'Fictional question about the program lesson.',acknowledgement:MESSAGE_ACK});
async function raw(input:unknown){
 return db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'clinical_data','synthetic-staging','synthetic_only')",[owner,org,'subject-'+owner]);
  return tx.query('select clinical_core.care_message_request($1::jsonb)',[JSON.stringify(input)]);
 });
}
beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 for(const file of ['20260812010000_synthetic_identity_consent.sql','20260812220000_identity_function_column_qualification.sql','20260821010000_governed_synthetic_lab_import.sql','20260929090000_synthetic_care_messages.sql','20260929100000_synthetic_care_message_receipts.sql'])
  await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional A'),($2,'Fictional B')",[org,otherOrg]);
 for(const [person,pool] of [[owner,'consumer'],[other,'consumer'],[clinician,'workforce'],[outside,'workforce'],[admin,'workforce']]){
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[person,'syn_'+person.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)',[person,pool,'subject-'+person]);
 }
 await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($3,$4,'practitioner')",[org,clinician,otherOrg,outside]);
 await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_messages_01')",[patient,org]);
 await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,owner]);
},30000);
afterAll(async()=>{await db?.close();});
describe('synthetic care messages: real adapter and PostgreSQL, not hosted AWS',()=>{
 it('recovers metadata for committed new threads and replies without returning content',async()=>{
  const input=command();if(input.action!=='send')throw Error();
  const sent=await request(input);if(sent.action!=='send')throw Error();
  const lookup={action:'receipt' as const,requestId:input.requestId,connectionId:connection};
  expect(await request(lookup)).toEqual({...lookup,status:'committed',threadId:sent.threadId,messageId:sent.messageId});
  const reply={...input,requestId:id(++serial),subject:undefined,threadId:sent.threadId};
  const replied=await request(reply);if(replied.action!=='send')throw Error();
  expect(await request({...lookup,requestId:reply.requestId})).toEqual({...lookup,requestId:reply.requestId,status:'committed',threadId:sent.threadId,messageId:replied.messageId});
 });
 it('does not turn an absent receipt into a cancellation and observes a later commit',async()=>{
  const input=command();if(input.action!=='send')throw Error();
  const lookup={action:'receipt' as const,requestId:input.requestId,connectionId:connection};
  expect(await request(lookup)).toEqual({...lookup,status:'unresolved'});
  const sent=await request(input);if(sent.action!=='send')throw Error();
  expect(await request(lookup)).toEqual({...lookup,status:'committed',threadId:sent.threadId,messageId:sent.messageId});
 });
 it('refuses receipt lookup by other owners, clinics, workforce and missing or revoked connections',async()=>{
  const input=command();if(input.action!=='send')throw Error();await request(input);
  const lookup={action:'receipt' as const,requestId:input.requestId,connectionId:connection};
  for(const [actor,organization,pool] of [[other,org,'consumer'],[owner,otherOrg,'consumer'],[clinician,org,'workforce']] as const)
   await expect(request(lookup,actor,organization,pool)).rejects.toMatchObject({category:'identity_refused'});
  await expect(request({...lookup,connectionId:id(++serial)})).rejects.toThrow();
  await db.query("update clinical_core.patient_connections set state='paused' where id=$1",[connection]);
  try{await expect(request(lookup)).rejects.toThrow();}
  finally{await db.query("update clinical_core.patient_connections set state='verified' where id=$1",[connection]);}
 });
 it('isolates colliding request IDs by owner and exact connection',async()=>{
  const otherPatient=id(++serial),otherConnection=id(++serial),secondPatient=id(++serial),secondConnection=id(++serial);
  for(const [p,c,o] of [[otherPatient,otherConnection,other],[secondPatient,secondConnection,owner]]){
   await db.query('insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,$3)',[p,org,'patient_syn_receipt_'+p.replaceAll('-','')]);
   await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,$5,now())",[c,org,p,o,o===owner?'revoked':'verified']);
  }
  const input=command();if(input.action!=='send')throw Error();const sent=await request(input);if(sent.action!=='send')throw Error();
  const lookup={action:'receipt' as const,requestId:input.requestId,connectionId:otherConnection};
  expect(await request(lookup,other)).toEqual({...lookup,status:'unresolved'});
  const theirs=await request({...input,connectionId:otherConnection},other);if(theirs.action!=='send')throw Error();
  expect(await request(lookup,other)).toEqual({...lookup,status:'committed',threadId:theirs.threadId,messageId:theirs.messageId});
  expect(theirs.messageId).not.toBe(sent.messageId);
  await db.query("update clinical_core.patient_connections set state='revoked' where id=$1",[connection]);
  try{
   await db.query("update clinical_core.patient_connections set state='verified' where id=$1",[secondConnection]);
   expect(await request({...lookup,connectionId:secondConnection})).toEqual({...lookup,connectionId:secondConnection,status:'unresolved'});
   await expect(request({...lookup,connectionId:connection})).rejects.toThrow();
  }finally{
   await db.query("update clinical_core.patient_connections set state='revoked' where id in($1,$2)",[secondConnection,otherConnection]);
   await db.query("update clinical_core.patient_connections set state='verified' where id=$1",[connection]);
  }
 });
 it('validates receipt shape in SQL and binds API receipt replies to requested identifiers',async()=>{
  const lookup={action:'receipt' as const,requestId:id(++serial),connectionId:connection};
  await expect(db.transaction(async tx=>{
   await tx.exec('set local role clinical_core_api');
   await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'clinical_data','synthetic-staging','synthetic_only')",[owner,org,'subject-'+owner]);
   await tx.query('select clinical_core.care_message_receipt($1::jsonb)',[JSON.stringify({...lookup,body:'must not be accepted'})]);
  })).rejects.toThrow('care_message_invalid');
  expect(()=>parseCareMessageResponse(lookup,{...lookup,status:'unresolved',requestId:id(++serial)})).toThrow('message_response_mismatch');
  expect(()=>parseCareMessageResponse(lookup,{...lookup,status:'unresolved',connectionId:id(++serial)})).toThrow('message_response_mismatch');
  expect(careMessageResponse.safeParse({...lookup,status:'unresolved',threadId:id(++serial)}).success).toBe(false);
  expect(careMessageResponse.safeParse({...lookup,status:'committed'}).success).toBe(false);
 });
 it('enforces receipt identity at the SQL boundary even without the consumer-only adapter guard',async()=>{
  await expect(db.transaction(async tx=>{
   await tx.exec('set local role clinical_core_api');
   await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','synthetic-staging','synthetic_only')",[clinician,org,'subject-'+clinician]);
   await tx.query('select clinical_core.care_message_receipt($1::jsonb)',[JSON.stringify({action:'receipt',requestId:id(++serial),connectionId:connection})]);
  })).rejects.toThrow('care_message_refused');
  // The inherited composite foreign key prevents a connection pointing at another clinic's chart.
  await expect(db.query('update clinical_core.patient_connections set organization_id=$1 where id=$2',[otherOrg,connection])).rejects.toThrow('foreign key');
 });
 it('round trips consumer message, workforce inbox and reply, then consumer read',async()=>{
  const receipt=await request(command());expect(receipt.action).toBe('send');if(receipt.action!=='send')throw Error();
  const list=await request({action:'list'},clinician,org,'workforce');
  expect(list).toMatchObject({action:'list',threads:expect.arrayContaining([expect.objectContaining({threadId:receipt.threadId,connectionId:connection})])});
  const reply=await request({action:'send',requestId:id(++serial),threadId:receipt.threadId,connectionId:connection,body:'Fictional care team reply.',acknowledgement:MESSAGE_ACK},clinician,org,'workforce');
  expect(reply).toMatchObject({action:'send',status:'stored',duplicate:false});
  const read=await request({action:'read',threadId:receipt.threadId});
  expect(read).toMatchObject({action:'read',messages:[{sender:'workforce',body:'Fictional care team reply.'},{sender:'consumer'}]});
  expect(careMessageResponse.safeParse(read).success).toBe(true);
 });
 it('returns the same receipt on retry and rejects reuse with different content',async()=>{
  const input=command(),receipt=await request(input);
  expect(await request(input)).toEqual({...receipt,duplicate:true});
  await expect(request({...input,body:'Changed'} as CareMessageRequest)).rejects.toMatchObject({category:'conflict'});
 });
 it('refuses other patients, clinics, nonmembers and client-supplied identities',async()=>{
  const receipt=await request(command());if(receipt.action!=='send')throw Error();
  expect(await request({action:'list'},other)).toMatchObject({threads:[]});
  for(const [actor,organization,pool] of [[other,org,'consumer'],[owner,otherOrg,'consumer'],[outside,otherOrg,'workforce'],[outside,org,'workforce'],[admin,org,'workforce']] as const){
   await expect(request({action:'read',threadId:receipt.threadId},actor,organization,pool)).rejects.toThrow();
   await expect(request(command(),actor,organization,pool)).rejects.toThrow();
  }
  await expect(raw({...command(),sender_id:clinician})).rejects.toThrow('care_message_invalid');
 });
 it('refuses paused links for reads, sends and retries, and clears them from listing',async()=>{
  const input=command(),receipt=await request(input);if(receipt.action!=='send')throw Error();
  await db.query("update clinical_core.patient_connections set state='paused' where id=$1",[connection]);
  try{
   await expect(request(input)).rejects.toThrow();
   await expect(request({action:'read',threadId:receipt.threadId})).rejects.toThrow();
   expect(await request({action:'list'})).toMatchObject({threads:[]});
  }finally{await db.query("update clinical_core.patient_connections set state='verified' where id=$1",[connection]);}
 });
 it('refuses disabled identities and archived patient records',async()=>{
  const lookup={action:'receipt' as const,requestId:id(++serial),connectionId:connection};
  await db.query("update clinical_core.identities set status='disabled' where person_id=$1",[owner]);
  try{await expect(request({action:'list'})).rejects.toThrow();await expect(request(lookup)).rejects.toThrow();}finally{await db.query("update clinical_core.identities set status='active' where person_id=$1",[owner]);}
  await db.query("update clinical_core.patient_records set status='archived' where id=$1",[patient]);
  try{await expect(request(command())).rejects.toThrow();await expect(request(lookup)).rejects.toThrow();expect(await request({action:'list'})).toMatchObject({threads:[]});}
  finally{await db.query("update clinical_core.patient_records set status='active' where id=$1",[patient]);}
 });
 it('checks content and acknowledgement even when the API schema is bypassed',async()=>{
  for(const input of [{},{...command(),body:''},{...command(),body:'x'.repeat(4001)},{...command(),body:{text:'object'}},{...command(),subject:[]},{...command(),acknowledgement:'skip'}])
   await expect(raw(input)).rejects.toThrow();
  await expect(createCareMessaging(database)(context(),{...command(),extra:'forbidden'})).rejects.toMatchObject({category:'request_invalid'});
 });
 it('pages messages by stable cursor with no duplication or fabricated content',async()=>{
  const receipt=await request(command());if(receipt.action!=='send')throw Error();
  for(let i=0;i<51;i++)await request({action:'send',requestId:id(++serial),connectionId:connection,threadId:receipt.threadId,body:'Fictional message '+i,acknowledgement:MESSAGE_ACK});
  const first=await request({action:'read',threadId:receipt.threadId});if(first.action!=='read'||!first.nextBefore)throw Error();
  expect(first.messages).toHaveLength(50);
  const second=await request({action:'read',threadId:receipt.threadId,before:first.nextBefore});if(second.action!=='read')throw Error();
  expect(second.messages).toHaveLength(2);
  expect(new Set([...first.messages,...second.messages].map(m=>m.messageId)).size).toBe(52);
 });
 it('prevents direct table reads/writes and keeps audit content-free',async()=>{
  await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');await tx.query('select * from clinical_core.care_messages');})).rejects.toThrow('permission denied');
  await expect(db.exec("update clinical_core.care_messages set body='changed'")).rejects.toThrow();
  await expect(db.exec('delete from clinical_core.care_message_audit')).rejects.toThrow();
  const audit=await db.query('select * from clinical_core.care_message_audit limit 1');
  expect(audit.rows[0]).not.toHaveProperty('body');expect(audit.rows[0]).not.toHaveProperty('subject');
 });
 it('refuses production before touching the database',async()=>{
  await expect(createCareMessaging({transaction:()=>{throw Error('must not run');}})({...context(),environment:'production'} as unknown as SyntheticRequestContext,command())).rejects.toMatchObject({category:'identity_refused'});
 });
});
