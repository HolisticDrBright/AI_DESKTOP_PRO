import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const calls=vi.hoisted(()=>({reconcile:vi.fn(),sweep:vi.fn()}));
vi.mock('./lab-deletion-cleanup',async original=>({...await original<typeof import('./lab-deletion-cleanup')>(),
  reconcileLabDeletion:calls.reconcile,sweepLabDeletions:calls.sweep}));
import {labCleanupHandler} from './aws-lab-cleanup-lambda';
const id='10000000-0000-4000-8000-000000000001',key='synthetic-labs/artifacts/'+id+'/result.json';
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('PHI_ALLOWED','false');vi.stubEnv('DATA_CLASSIFICATION','synthetic_only');
  vi.stubEnv('LAB_JOB_TABLE','fictional-table');vi.stubEnv('LAB_DOCUMENT_BUCKET','fictional-bucket');
  calls.reconcile.mockResolvedValue({cleanupStatus:'late_upload_watch'});calls.sweep.mockResolvedValue({checked:0});
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
it('routes minimal events through the durable cleanup record, not event identity',async()=>{
  expect(await labCleanupHandler({kind:'created',bucket:'fictional-bucket',key})).toEqual({checked:1});
  expect(calls.reconcile).toHaveBeenCalledWith(expect.objectContaining({bucket:'fictional-bucket'}),id,undefined,key);
  expect(await labCleanupHandler({kind:'sweep'})).toEqual({checked:0});
});
it('ordinary live objects without a cleanup record are left untouched',async()=>{
  calls.reconcile.mockResolvedValue(null);
  expect(await labCleanupHandler({kind:'created',bucket:'fictional-bucket',key})).toEqual({checked:0});
});
it('personal cleanup requires full activation evidence and carries the real database guard',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  vi.stubEnv('PHI_ALLOWED','true');vi.stubEnv('DATA_CLASSIFICATION','personal_health_record');vi.stubEnv('LAB_OBJECT_PREFIX','personal-labs');
  await expect(labCleanupHandler({kind:'sweep'})).rejects.toThrow('lab_cleanup_retry_required');
  expect(calls.sweep).not.toHaveBeenCalled();
  vi.stubEnv('PERSONAL_LAB_ACTIVATION','approved');vi.stubEnv('PERSONAL_LAB_EVIDENCE_SHA256','a'.repeat(64));
  vi.stubEnv('PERSONAL_LAB_PROVIDER_EVIDENCE_SHA256','b'.repeat(64));vi.stubEnv('PERSONAL_LAB_ALLOWED_SCOPES','ai_context,lab_history');
  await labCleanupHandler({kind:'sweep'});
  expect(calls.sweep).toHaveBeenCalledWith(expect.objectContaining({deletionGuard:expect.any(Function)}));
});
it.each([
  null,{kind:'sweep',extra:'refuse'},{kind:'created',bucket:'other',key},
  {kind:'created',bucket:'fictional-bucket',key:'unrelated/object'},
  {kind:'created',bucket:'fictional-bucket',key,patient:'must-not-be-logged'},
])('refuses malformed events without echoing the input',async event=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  await expect(labCleanupHandler(event)).rejects.toThrow('lab_cleanup_retry_required');
  expect(calls.reconcile).not.toHaveBeenCalled();expect(calls.sweep).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('lab_cleanup_failed');
});
it('refuses PHI posture and never logs raw SDK or payload errors',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  vi.stubEnv('PHI_ALLOWED','true');
  await expect(labCleanupHandler({kind:'sweep'})).rejects.toThrow('lab_cleanup_retry_required');
  expect(calls.sweep).not.toHaveBeenCalled();
  vi.stubEnv('PHI_ALLOWED','false');calls.sweep.mockRejectedValue(new Error('secret-token private-lab-body'));
  await expect(labCleanupHandler({kind:'sweep'})).rejects.toThrow('lab_cleanup_retry_required');
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-token|private-lab-body/);
});
it('provisions scoped late-upload events, retries, encrypted failure capture and due-index access',()=>{
  const t=JSON.parse(readFileSync('infra/aws-clinical-core/lab-analysis-extension.json','utf8')).Resources;
  expect(t.LabDocumentsBucket.Properties.NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled).toBe(true);
  expect(t.LabJobTable.Properties.GlobalSecondaryIndexes.find((row:{IndexName:string})=>row.IndexName==='LabCleanupDue').Projection).toEqual({ProjectionType:'KEYS_ONLY'});
  expect(t.LabCleanupFunction.Properties.Handler).toBe('index.cleanup');
  expect(t.LabCleanupFunction.Properties.Environment.Variables.PHI_ALLOWED).toBe('false');
  expect(t.LabCleanupFunction.Properties.Environment.Variables.DATA_CLASSIFICATION).toBe('synthetic_only');
  expect(t.LabCleanupObjectRule.Properties.EventPattern.detail.bucket.name).toEqual([{Ref:'LabDocumentsBucket'}]);
  expect(t.LabCleanupObjectRule.Properties.Targets[0].DeadLetterConfig.Arn).toEqual({'Fn::GetAtt':['LabCleanupFailureQueue','Arn']});
  expect(t.LabCleanupAsyncFailure.Properties.DestinationConfig.OnFailure.Destination).toEqual({'Fn::GetAtt':['LabCleanupFailureQueue','Arn']});
  expect(t.LabCleanupSweepRule.Properties.ScheduleExpression).toBe('rate(5 minutes)');
  expect(t.LabCleanupFailureQueue.Properties.SqsManagedSseEnabled).toBe(true);
  expect(t.LabCleanupObjectPermission.Properties.SourceArn).toEqual({'Fn::GetAtt':['LabCleanupObjectRule','Arn']});
  const permissions=JSON.stringify(t.LabCleanupRole);
  expect(permissions).not.toMatch(/s3:GetObject|s3:PutObject|secretsmanager|dynamodb:Scan/);
  expect(t.LabCleanupQueueAlarm.Properties.MetricName).toBe('ApproximateNumberOfMessagesVisible');
  expect(t.LabCleanupFailureAlarm.Properties.MetricName).toBe('Errors');
});
