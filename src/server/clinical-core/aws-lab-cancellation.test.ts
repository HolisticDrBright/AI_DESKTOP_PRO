import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const mock=vi.hoisted(()=>({db:vi.fn(),s3:vi.fn(),sfn:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async original=>({...await original<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mock.db})}}));
vi.mock('@aws-sdk/client-s3',async original=>({...await original<typeof import('@aws-sdk/client-s3')>(),S3Client:class{send=mock.s3;}}));
vi.mock('@aws-sdk/client-sfn',async original=>({...await original<typeof import('@aws-sdk/client-sfn')>(),SFNClient:class{send=mock.sfn;}}));
import {createAwsLabAnalysisApiHandler as handler} from './aws-lab-analysis-api';
import {stopLabExecutions} from './lab-execution-stop';
import {SFNClient} from '@aws-sdk/client-sfn';
const id='10000000-0000-4000-8000-000000000001',owner='20000000-0000-4000-8000-000000000001';
const machine='arn:aws:states:us-east-2:588966314750:stateMachine:fictional-synthetic-lab-analysis';
let job:Record<string,unknown>|undefined,ledger:Record<string,unknown>|undefined;
const refused=(name='TransactionCanceledException')=>Object.assign(new Error('refused'),{name});
const event=(body:unknown={confirmRemoveUnfinishedAnalysis:true},identity=owner)=>({
  rawPath:`/clinical-core/consumer/labs/jobs/${id}/cancel`,body:JSON.stringify(body),
  requestContext:{http:{method:'POST'},authorizer:{jwt:{claims:{sub:identity,'custom:organization_id':owner,'custom:person_id':owner,'custom:synthetic_attested':'true'}}}}});
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('LAB_JOB_TABLE','fictional');vi.stubEnv('LAB_DOCUMENT_BUCKET','fictional');vi.stubEnv('LAB_STATE_MACHINE_ARN',machine);
  job={pk:'job#'+id,ownerSub:owner,organizationId:owner,personId:owner,state:'extracting',leaseToken:'old-worker',leaseUntil:Date.now()+600000};ledger=undefined;
  mock.sfn.mockResolvedValue({stopDate:new Date()});mock.s3.mockResolvedValue({});
  mock.db.mockImplementation(async command=>{
    const input=command.input,name=command.constructor.name;
    if(name==='GetCommand')return {Item:structuredClone(input.Key.pk.startsWith('cleanup#')?ledger:job)};
    if(name==='TransactWriteCommand'){
      const claim=input.TransactItems[0].Update,values=claim.ExpressionAttributeValues;
      const allowed=String(claim.ConditionExpression).match(/#state IN \(([^)]+)\)/)![1].split(',').map(k=>values[k.trim()]);
      if(!job||job.ownerSub!==values[':owner']||job.organizationId!==values[':org']||job.personId!==values[':person']||!allowed.includes(job.state))throw refused();
      expect(claim.UpdateExpression).toContain('REMOVE leaseToken, leaseUntil');
      job.state='deleting';delete job.leaseToken;delete job.leaseUntil;
      const out=input.TransactItems[1].Update.ExpressionAttributeValues;
      ledger={pk:'cleanup#'+id,ownerSub:owner,organizationId:owner,personId:owner,contractVersion:out[':version'],requestedAt:out[':now'],cleanupPartition:'pending',cleanupDue:out[':now'],stopRequired:out[':yes']};
      return {};
    }
    if(name==='DeleteCommand'){expect(job?.state??'deleting').toBe('deleting');job=undefined;return {};}
    if(name==='UpdateCommand'){
      expect(input.ConditionExpression).toContain(ledger?.stopRequired?'stopRequired = :yes':'attribute_not_exists(stopRequired)');
      ledger={...ledger,cleanupPartition:'watching',lastVerifiedAt:input.ExpressionAttributeValues[':now'],cleanupDue:input.ExpressionAttributeValues[':next']};
      delete ledger.stopRequired;return {};
    }
    throw new Error('unexpected command');
  });
});
afterEach(()=>vi.unstubAllEnvs());
it.each(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing'])('fences and removes an unfinished %s job, including its active lease',async state=>{
  job!.state=state;
  mock.sfn.mockImplementation(async()=>{expect(job?.state).toBe('deleting');expect(job?.leaseToken).toBeUndefined();expect(ledger?.stopRequired).toBe(true);expect(mock.s3).not.toHaveBeenCalled();return {stopDate:new Date()};});
  const result=await handler(event());expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).data).toMatchObject({contractVersion:'lab-cancellation/1',jobId:id,cancelled:true,deleted:true,cleanupStatus:'late_upload_watch'});
  expect(job).toBeUndefined();expect(ledger).toMatchObject({cleanupPartition:'watching'});expect(ledger?.stopRequired).toBeUndefined();
  expect(mock.sfn).toHaveBeenCalledTimes(2);
  expect((await handler(event())).statusCode).toBe(200); // Lost acknowledgement retry; no repeat workflow stop.
  expect(mock.sfn).toHaveBeenCalledTimes(2);
});
it.each(['completed','needs_review','failed'])('preserves a terminal %s result rather than treating cancellation as deletion',async state=>{
  job!.state=state;expect((await handler(event())).statusCode).toBe(409);
  expect(mock.sfn).not.toHaveBeenCalled();expect(mock.s3).not.toHaveBeenCalled();expect(job?.state).toBe(state);
});
it('refuses cross-user cancellation, including after the owned job has been removed',async()=>{
  expect((await handler(event(undefined,id))).statusCode).toBe(404);expect(mock.sfn).not.toHaveBeenCalled();
  expect((await handler(event())).statusCode).toBe(200);mock.sfn.mockClear();mock.s3.mockClear();
  expect((await handler(event(undefined,id))).statusCode).toBe(404);expect(mock.sfn).not.toHaveBeenCalled();expect(mock.s3).not.toHaveBeenCalled();
});
it.each([{}, {confirmRemoveUnfinishedAnalysis:false},{confirmRemoveUnfinishedAnalysis:true,executionArn:'attacker'}])('requires exact explicit confirmation without an execution-ARN input',async input=>{
  expect((await handler(event(input))).statusCode).toBe(400);expect(mock.db).not.toHaveBeenCalled();
});
it('does not erase a result that completes between the owned read and atomic cancellation claim',async()=>{
  const original=mock.db.getMockImplementation()!;
  mock.db.mockImplementation(async c=>{if(c.constructor.name==='TransactWriteCommand')job!.state='completed';return original(c);});
  expect((await handler(event())).statusCode).toBe(409);expect(job?.state).toBe('completed');expect(ledger).toBeUndefined();expect(mock.s3).not.toHaveBeenCalled();
});
it('keeps a retryable durable stop requirement on workflow failure and never claims success',async()=>{
  mock.sfn.mockRejectedValueOnce(new Error('private provider detail'));
  const result=await handler(event());expect(result.statusCode).toBe(503);expect(result.body).not.toContain('private');
  expect(job?.state).toBe('deleting');expect(ledger?.stopRequired).toBe(true);expect(mock.s3).not.toHaveBeenCalled();
  expect((await handler(event())).statusCode).toBe(200);expect(job).toBeUndefined();
});
it('derives two exact execution names and only tolerates ExecutionDoesNotExist',async()=>{
  mock.sfn.mockRejectedValueOnce(refused('ExecutionDoesNotExist')).mockResolvedValueOnce({stopDate:new Date()});
  await stopLabExecutions(new SFNClient({}),machine,id);
  expect(mock.sfn.mock.calls.map(([c])=>c.input)).toEqual(['lab','lab-plan'].map(prefix=>({executionArn:machine.replace(':stateMachine:',':execution:')+':'+prefix+'-'+id})));
  mock.sfn.mockRejectedValue(new Error('unavailable'));await expect(stopLabExecutions(new SFNClient({}),machine,id)).rejects.toThrow();
  mock.sfn.mockClear();await expect(stopLabExecutions(new SFNClient({}),machine+':other',id)).rejects.toThrow();expect(mock.sfn).not.toHaveBeenCalled();
});
it('rejects an unconfirmed workflow stop response',async()=>{
  mock.sfn.mockResolvedValue({});expect((await handler(event())).statusCode).toBe(503);expect(mock.s3).not.toHaveBeenCalled();
});
it('uses authenticated cancellation routes and scoped workflow-stop permission without arbitrary workflow access',()=>{
  const t=JSON.parse(readFileSync('infra/aws-clinical-core/lab-analysis-extension.json','utf8'));
  expect(t.Resources.CancelConsumerLabJobRoute.Properties.AuthorizationType).toBe('JWT');
  expect(t.Resources.CancelSyntheticLabJobRoute.Properties.AuthorizationType).toBe('CUSTOM');
  const statement=t.Resources.LabCancellationPolicy.Properties.PolicyDocument.Statement;
  expect(statement).toHaveLength(1);expect(statement[0].Action).toBe('states:StopExecution');
  expect(statement[0].Resource[0]['Fn::Sub']).toContain(':execution:${ClinicalApiId}-synthetic-lab-analysis:lab-*');
});
