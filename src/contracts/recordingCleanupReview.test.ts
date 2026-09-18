import {expect,it} from 'vitest';
import {parseCleanupReviewResponse} from './recordingCleanupReview';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const capabilities={review:true,dispatch:false,storageDeletion:false};
const date='2026-09-17T00:00:00Z';
const item=(n:number)=>({recordingId:id(n),patientRecordId:id(999),version:1,reason:'discard',dueAt:date,nextCheckAt:date,
  leaseUntil:null,lastOutcome:null,consecutiveFailures:0,unresolvedAttempts:0,audioDeleted:false,requiresRecheck:true});
it('accepts exact pages and preserves unknown history counts',()=>{
  const data={items:Array.from({length:25},(_,i)=>item(i+1)),nextAfter:id(25)};
  expect(parseCleanupReviewResponse({action:'queue'},{data,capabilities}).data).toEqual(data);
  const history={recordingId:id(1),runs:[{runId:id(2),version:1,claimedAt:date,leaseUntil:date,leaseActive:false,
    result:{outcome:'unavailable',deleteAcknowledged:null,recordedAt:date,appliedToSchedule:false,nextCheckAt:null},audioDeleted:false,requiresRecheck:true}],nextAfter:null};
  expect(parseCleanupReviewResponse({action:'history',recordingId:id(1)},{data:history,capabilities}).data).toEqual(history);
});
it.each([
  {items:[item(1),item(1)],nextAfter:null},{items:[item(2),item(1)],nextAfter:null},
  {items:[item(2)],nextAfter:id(2)},{items:Array.from({length:25},(_,i)=>item(i+1)),nextAfter:null},
  {items:[{...item(1),audioDeleted:true}],nextAfter:null},{items:[{...item(1),requiresRecheck:false}],nextAfter:null},
  {items:[{...item(1),objectKey:'private'}],nextAfter:null},
])('rejects invalid page/proof claims',data=>{expect(()=>parseCleanupReviewResponse({action:'queue'},{data,capabilities})).toThrow();});
it('refuses a page at or before the requested cursor',()=>{
  expect(()=>parseCleanupReviewResponse({action:'queue',after:id(2)},{data:{items:[item(2)],nextAfter:null},capabilities})).toThrow();
});
