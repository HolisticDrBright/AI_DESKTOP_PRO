import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({db:vi.fn(),s3:vi.fn(),sfn:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async original=>({...await original<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:mock.db})}}));
vi.mock('@aws-sdk/client-s3',async original=>({...await original<typeof import('@aws-sdk/client-s3')>(),S3Client:class{send=mock.s3;}}));
vi.mock('@aws-sdk/client-sfn',async original=>({...await original<typeof import('@aws-sdk/client-sfn')>(),SFNClient:class{send=mock.sfn;}}));
import {createLabAnalysisApi,createAwsLabAnalysisApiHandler as synthetic} from './aws-lab-analysis-api';
import {OwnedStorageError} from './owned-consumer-records';
const id='10000000-0000-4000-8000-000000000001',owner='20000000-0000-4000-8000-000000000001';
let job:Record<string,unknown>|undefined,ledger:Record<string,unknown>|undefined;
const event=(sub=owner)=>({rawPath:`/clinical-core/consumer/labs/jobs/${id}`,body:undefined,
  requestContext:{http:{method:'DELETE'},authorizer:{jwt:{claims:{sub,'custom:organization_id':owner,'custom:person_id':owner,'custom:synthetic_attested':'true'}}}}});
const retraction=(status:'retracted'|'retained'|'not_published',extra:Record<string,unknown>={})=>({version:'lab-publication/1' as const,status,at:'2026-09-18T12:00:00.000Z',...extra});
const production=(retract?:(job:unknown)=>Promise<unknown>)=>createLabAnalysisApi({mode:'production',
  identity:e=>{const c=(e as {requestContext:{authorizer:{jwt:{claims:Record<string,string>}}}}).requestContext.authorizer.jwt.claims;return {sub:c.sub,'custom:person_id':c['custom:person_id'],'custom:organization_id':c['custom:organization_id']};},
  capture:async()=>{throw new Error('not creation');},policy:{verify:async()=>{}},requireCore:async()=>{},revalidatePrivacyIdentity:async()=>{},
  deletionGuard:async(_scope,operation)=>operation(),...(retract?{retract:retract as never}:{})});
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('LAB_JOB_TABLE','fictional');vi.stubEnv('LAB_DOCUMENT_BUCKET','fictional');vi.stubEnv('LAB_STATE_MACHINE_ARN','arn:aws:states:us-east-2:000000000000:stateMachine:fictional');
  vi.stubEnv('LAB_OBJECT_PREFIX','personal-labs');
  job={pk:'job#'+id,ownerSub:owner,organizationId:owner,personId:owner,state:'completed',dataClassification:'personal_health_record',result:{analysisId:id},
    publication:{version:'lab-publication/1',status:'published',resultSha256:'a'.repeat(64),at:'2026-09-18T11:00:00.000Z',recordId:id,revision:1}};ledger=undefined;
  mock.s3.mockResolvedValue({});
  mock.db.mockImplementation(async command=>{
    const input=command.input,name=command.constructor.name;
    if(name==='GetCommand')return {Item:structuredClone(input.Key.pk.startsWith('cleanup#')?ledger:job)};
    if(name==='TransactWriteCommand'){
      const values=input.TransactItems[0].Update.ExpressionAttributeValues;
      if(!job||job.ownerSub!==values[':owner'])throw Object.assign(new Error('refused'),{name:'TransactionCanceledException'});
      job.state='deleting';const out=input.TransactItems[1].Update.ExpressionAttributeValues;
      ledger={pk:'cleanup#'+id,ownerSub:owner,organizationId:owner,personId:owner,contractVersion:out[':version'],requestedAt:out[':now'],cleanupPartition:'pending',cleanupDue:out[':now']};return {};
    }
    if(name==='DeleteCommand'){job=undefined;return {};}
    if(name==='UpdateCommand'){ledger={...ledger,cleanupPartition:'watching',lastVerifiedAt:input.ExpressionAttributeValues[':now'],cleanupDue:input.ExpressionAttributeValues[':next']};return {};}
    throw new Error('unexpected command '+name);
  });
});
afterEach(()=>vi.unstubAllEnvs());
describe('cloud copy retraction during job deletion',()=>{
  it('retracts the personal copy before the deletion is claimed and reports the outcome with the cleanup receipt',async()=>{
    const order:string[]=[];
    const retract=vi.fn(async(target:unknown)=>{order.push('retract:'+(target as {state:string}).state);expect(ledger).toBeUndefined();return retraction('retracted',{recordId:id,revision:2});});
    const response=await production(retract)(event());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data).toMatchObject({jobId:id,deleted:true,cleanupStatus:'late_upload_watch',publication:{status:'retracted',recordId:id,revision:2}});
    expect(order).toEqual(['retract:completed']);expect(job).toBeUndefined();expect(ledger).toMatchObject({cleanupPartition:'watching'});
  });
  it('reports a retained copy without blocking the deletion, and skips retraction for jobs that never completed',async()=>{
    const retained=await production(async()=>retraction('retained',{recordId:id,revision:1,reason:'lab_consent_required'}))(event());
    expect(retained.statusCode).toBe(200);expect(JSON.parse(retained.body).data.publication).toMatchObject({status:'retained',reason:'lab_consent_required'});
    expect(job).toBeUndefined();
    job={pk:'job#'+id,ownerSub:owner,organizationId:owner,personId:owner,state:'failed',dataClassification:'personal_health_record'};ledger=undefined;
    const retract=vi.fn();const failed=await production(retract)(event());
    expect(failed.statusCode).toBe(200);expect(JSON.parse(failed.body).data.publication).toBeUndefined();expect(retract).not.toHaveBeenCalled();
  });
  it('refuses the whole deletion, changing nothing, when storage cannot confirm the retraction',async()=>{
    const response=await production(async()=>{throw new OwnedStorageError('storage_unavailable');})(event());
    expect(response.statusCode).toBe(503);expect(JSON.parse(response.body).data).toMatchObject({contractVersion:'lab-publication/1',error:'lab_publication_retraction_pending'});
    expect(job).toMatchObject({state:'completed'});expect(ledger).toBeUndefined();expect(mock.s3).not.toHaveBeenCalled();
  });
  it('never retracts for other owners, without a retract option, or in synthetic mode',async()=>{
    const retract=vi.fn(async()=>retraction('retracted'));
    const other=await production(retract)(event('30000000-0000-4000-8000-000000000001'));
    expect(other.statusCode).toBe(200);expect(JSON.parse(other.body).data.publication).toBeUndefined();expect(retract).not.toHaveBeenCalled();expect(job).toMatchObject({state:'completed'});
    const plain=await production()(event());expect(plain.statusCode).toBe(200);expect(JSON.parse(plain.body).data.publication).toBeUndefined();
    vi.stubEnv('LAB_OBJECT_PREFIX','synthetic-labs');
    job={pk:'job#'+id,ownerSub:owner,organizationId:owner,personId:owner,state:'completed',dataClassification:'synthetic_only',result:{analysisId:id}};ledger=undefined;
    const syntheticResponse=await synthetic(event());expect(syntheticResponse.statusCode).toBe(200);expect(JSON.parse(syntheticResponse.body).data.publication).toBeUndefined();
  });
});
