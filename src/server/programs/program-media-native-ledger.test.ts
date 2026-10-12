import {describe,it,expect,vi} from 'vitest';
import type {ClinicalCoreDatabase} from '@/server/clinical-core/database';
import type {ClinicalRequestContext} from '@/server/clinical-core/aws-identity-consent';
import {createProgramMediaNativeLedger,PROGRAM_MEDIA_NATIVE_LEDGER_CONTRACT} from './program-media-native-ledger';

const id=(n:number)=>'72000000-0000-4000-8000-'+String(n).padStart(12,'0');
const context={actorPersonId:id(1),organizationId:id(2),identityPool:'workforce',identitySubject:'syn_media_transport_actor',purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false} as ClinicalRequestContext;
const sha256='b'.repeat(64);
const storage={purpose:'educational_media' as const,phiAllowed:false as const,dedicated:true as const,bucket:'alp-synthetic-lessons',expectedBucketOwner:'588966314750',region:'us-east-2',kmsKeyArn:'arn:aws:kms:us-east-2:588966314750:key/'+id(99),maxImageBytes:16_777_216,maxVideoBytes:268_435_456,publicOrigin:'https://lessons.example.test/'};
const reservation={artifactId:id(3),clinic:id(2),programId:id(4),commandId:id(5),kind:'image' as const,contentType:'image/png' as const,bytes:30,sha256,objectKey:'program-media/'+id(2)+'/'+id(4)+'/'+id(3)+'/'+sha256+'.png',state:'reserved' as const,acceptBefore:'2026-10-11T17:00:00Z',createdAt:'2026-10-11T16:45:00Z',replayed:false,failure:null};
const artifact={artifactId:reservation.artifactId,clinic:reservation.clinic,programId:reservation.programId,kind:reservation.kind,contentType:reservation.contentType,bytes:reservation.bytes,sha256,objectKey:reservation.objectKey,version:1,state:'reserved' as const,objectVersion:null,committedAt:null,retiredAt:null,failure:null,caption:null,transcript:null};
function fixture(data:unknown){
 const committed=vi.fn(),rolledBack=vi.fn(),sql:string[]=[];
 const database:ClinicalCoreDatabase={transaction:async work=>{
  try{const result=await work({query:async <T>(query:string)=>{sql.push(query);return {rows:(query.includes('program_media_request')?[{data:{contractVersion:PROGRAM_MEDIA_NATIVE_LEDGER_CONTRACT,ok:true,data}}]:[]) as T[]};}});committed();return result;}
  catch(error){rolledBack();throw error;}
 }};
 return {ledger:createProgramMediaNativeLedger(database,{evidenceSha256:'a'.repeat(64),storage}),committed,rolledBack,sql};
}
describe('native media transport response binding and closed errors',()=>{
 it.each([
  ['a foreign clinic',{...artifact,clinic:id(6)}],
  ['another artifact',{...artifact,artifactId:id(7)}],
  ['an unrelated object key',{...artifact,objectKey:'some-other-prefix/object.png'}],
  ['a mismatched kind/type',{...artifact,kind:'video',contentType:'image/png'}],
  ['oversized image bytes',{...artifact,bytes:16_777_217}],
 ])('refuses %s before committing its transaction',async(_name,reply)=>{
  const f=fixture(reply);await expect(f.ledger.artifact(context,id(3))).rejects.toThrow('service_unavailable');
  expect(f.committed).not.toHaveBeenCalled();expect(f.rolledBack).toHaveBeenCalledOnce();
 });
 it('refuses a reservation from another command/program rather than acknowledging replay',async()=>{
  const f=fixture({...reservation,commandId:id(9),replayed:true});
  await expect(f.ledger.reserve(context,reservation)).rejects.toThrow('service_unavailable');expect(f.committed).not.toHaveBeenCalled();
 });
 it('refuses foreign, duplicate and not-yet-expired cleanup rows',async()=>{
  for(const rows of [[{...reservation,programId:id(9)}],[reservation,reservation],[{...reservation,acceptBefore:'2099-01-01T00:00:00Z'}]]){
   const f=fixture(rows);await expect(f.ledger.expiredReservations(context,id(4),'2026-10-11T17:01:00Z')).rejects.toThrow('service_unavailable');expect(f.committed).not.toHaveBeenCalled();
  }
 });
 it('uses an opaque failure for malformed replies and rejects invalid context before SQL',async()=>{
  const f=fixture({provider:'sensitive-provider-error'});
  await expect(f.ledger.artifact(context,id(3))).rejects.toThrow(/^service_unavailable$/);
  const invalid=fixture(null);await expect(invalid.ledger.artifact({...context,actorPersonId:'not-an-id'},id(3))).rejects.toThrow(/^access_refused$/);expect(invalid.sql).toEqual([]);
 });
 it('accepts the exact owner-bound row and commits once',async()=>{
  const f=fixture(artifact);expect(await f.ledger.artifact(context,id(3))).toEqual(artifact);expect(f.committed).toHaveBeenCalledOnce();expect(f.sql).toHaveLength(2);
 });
});
