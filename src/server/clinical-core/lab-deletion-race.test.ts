import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({db:vi.fn(),s3:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async original=>({...await original<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mocks.db})}}));
vi.mock('@aws-sdk/client-s3',async original=>({...await original<typeof import('@aws-sdk/client-s3')>(),S3Client:class{send=mocks.s3;}}));
import {createAwsLabAnalysisApiHandler as handler} from './aws-lab-analysis-api';
const id='10000000-0000-4000-8000-000000000001',owner='20000000-0000-4000-8000-000000000001';
let row:Record<string,unknown>|undefined;
const event=(method='DELETE',claims:Record<string,string>={})=>({rawPath:`/clinical-core/consumer/labs/jobs/${id}`,
  requestContext:{http:{method},authorizer:{jwt:{claims:{sub:owner,'custom:organization_id':owner,'custom:person_id':owner,'custom:synthetic_attested':'true',...claims}}}}});
const collision=()=>Object.assign(new Error('conditional refusal'),{name:'ConditionalCheckFailedException'});
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('LAB_JOB_TABLE','fictional-table');vi.stubEnv('LAB_DOCUMENT_BUCKET','fictional-bucket');
  row={pk:'job#'+id,ownerSub:owner,organizationId:owner,personId:owner,state:'awaiting_upload',documents:[]};
  mocks.db.mockImplementation(async command=>{
    const input=command.input;
    if(command.constructor.name==='GetCommand')return {Item:row?structuredClone(row):undefined};
    if(command.constructor.name==='UpdateCommand'){
      expect(input.ConditionExpression).toContain('organizationId = :org AND personId = :person');
      expect(input.ConditionExpression).toContain('leaseUntil <= :epoch');
      if(!row||!['awaiting_upload','completed','needs_review','failed','deleting'].includes(String(row.state))
        ||Number(row.leaseUntil??0)>Date.now())throw collision();
      row.state='deleting';return {};
    }
    if(command.constructor.name==='DeleteCommand'){
      expect(input.ConditionExpression).toContain('#state = :deleting');
      if(row&&row.state!=='deleting')throw collision();row=undefined;return {};
    }
    throw new Error('unexpected command');
  });
  mocks.s3.mockImplementation(async()=>{expect(row?.state).toBe('deleting');return {};});
});
afterEach(()=>vi.unstubAllEnvs());
it('claims deletion before purging and makes a retry after completion idempotent',async()=>{
  expect((await handler(event())).statusCode).toBe(200);expect(row).toBeUndefined();
  expect(mocks.s3).toHaveBeenCalledTimes(2);expect((await handler(event())).statusCode).toBe(200);
  expect(mocks.s3).toHaveBeenCalledTimes(2);
});
it('does not purge when upload completion wins after the eligibility read',async()=>{
  const original=mocks.db.getMockImplementation()!;
  mocks.db.mockImplementation(async command=>{if(command.constructor.name==='UpdateCommand')row!.state='queued';return original(command);});
  expect((await handler(event())).statusCode).not.toBe(200);expect(mocks.s3).not.toHaveBeenCalled();expect(row?.state).toBe('queued');
});
it('does not purge when a worker lease becomes active',async()=>{
  row!.state='failed';row!.leaseUntil=Date.now()+100000;
  expect((await handler(event())).statusCode).not.toBe(200);expect(mocks.s3).not.toHaveBeenCalled();expect(row).toBeDefined();
});
it('keeps the durable deleting state after object-store failure and permits retry',async()=>{
  mocks.s3.mockRejectedValueOnce(new Error('object storage unavailable'));
  expect((await handler(event())).statusCode).not.toBe(200);expect(row?.state).toBe('deleting');
  expect(mocks.db.mock.calls.some(([c])=>c.constructor.name==='DeleteCommand')).toBe(false);
  expect((await handler(event())).statusCode).toBe(200);expect(row).toBeUndefined();
});
it.each(['sub','custom:organization_id','custom:person_id'])('never reads or purges another scope: %s',async claim=>{
  expect((await handler(event('GET',{[claim]:id}))).statusCode).toBe(404);
  await handler(event('DELETE',{[claim]:id}));expect(mocks.s3).not.toHaveBeenCalled();expect(row).toBeDefined();
  expect(mocks.db.mock.calls.every(([c])=>c.constructor.name==='GetCommand')).toBe(true);
});
it('does not delete a job whose state changed unexpectedly during cleanup',async()=>{
  mocks.s3.mockImplementation(async()=>{row!.state='queued';return {};});
  expect((await handler(event())).statusCode).not.toBe(200);expect(row).toBeDefined();
});
