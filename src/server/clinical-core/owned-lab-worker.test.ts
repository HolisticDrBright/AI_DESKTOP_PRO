import {afterEach,beforeEach,describe,expect,test,vi} from 'vitest';
const mock=vi.hoisted(()=>({db:vi.fn(),s3:vi.fn(),sfn:vi.fn(),textract:vi.fn(),openai:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',()=>{class Command{constructor(public input:Record<string,unknown>){}}return {DynamoDBDocumentClient:{from:()=>({send:mock.db})},
  GetCommand:class extends Command{},PutCommand:class extends Command{},UpdateCommand:class extends Command{},DeleteCommand:class extends Command{},TransactWriteCommand:class extends Command{},QueryCommand:class extends Command{}};});
vi.mock('@aws-sdk/client-s3',()=>{class Command{constructor(public input:Record<string,unknown>){}}return {S3Client:class{send=mock.s3;},GetObjectCommand:class extends Command{},PutObjectCommand:class extends Command{},
  HeadObjectCommand:class extends Command{},DeleteObjectsCommand:class extends Command{},ListObjectVersionsCommand:class extends Command{}};});
vi.mock('@aws-sdk/client-sfn',()=>({SFNClient:class{send=mock.sfn;},StartExecutionCommand:class{constructor(public input:Record<string,unknown>){}}}));
vi.mock('@aws-sdk/client-textract',()=>{class Command{constructor(public input:Record<string,unknown>){}}return {TextractClient:class{send=mock.textract;},AnalyzeDocumentCommand:class extends Command{},StartDocumentAnalysisCommand:class extends Command{},GetDocumentAnalysisCommand:class extends Command{}};});
vi.mock('./aws-lab-openai',()=>({synthesizeLabWithOpenAI:mock.openai}));
import {createAwsLabAnalysisWorker} from './aws-lab-analysis-worker';
import {LabAuthorizationRevoked,type LabAuthorization} from './owned-lab-authorization';
const uuid='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const authorization:LabAuthorization={version:'owned-lab/1',personId:uuid,organizationId:uuid,identitySubject:'owned-consumer-a',
  consents:{ai_context:{revision:1,releaseVersion:'r/1',contentSha256:'a'.repeat(64)},lab_history:{revision:1,releaseVersion:'r/1',contentSha256:'a'.repeat(64)}}};
const job=(patch:Record<string,unknown>={})=>({pk:`job#${jobId}`,ownerSub:'owned-consumer-a',organizationId:uuid,personId:uuid,state:'queued',passesCompleted:0,
  documents:[{clientDocumentId:uuid,fileName:'fictional.png',contentType:'image/png',byteSize:10,objectKey:`personal-labs/${uuid}/owned-consumer-a/${jobId}/${uuid}/fictional.png`}],...patch});
beforeEach(()=>{
  vi.clearAllMocks();mock.db.mockResolvedValue({});mock.s3.mockResolvedValue({});mock.textract.mockResolvedValue({Blocks:[]});
  vi.stubEnv('LAB_JOB_TABLE','fictional');vi.stubEnv('LAB_DOCUMENT_BUCKET','fictional');vi.stubEnv('LAB_KMS_KEY_ARN','fictional');vi.stubEnv('LAB_RANGE_MODE','synthetic_fixture');vi.stubEnv('LAB_OBJECT_PREFIX','personal-labs');
});
afterEach(()=>vi.unstubAllEnvs());
describe('production lab worker authorization',()=>{
  test('verifies consent before document extraction and stores artifacts in the personal namespace',async()=>{
    const verify=vi.fn(async()=>{});mock.db.mockResolvedValueOnce({Item:job({authorization})});
    expect(await createAwsLabAnalysisWorker({jobId,pass:0},{policy:{verify}})).toMatchObject({completed:true});
    expect(verify).toHaveBeenCalledTimes(2);expect(mock.textract).toHaveBeenCalledOnce();
    const put=mock.s3.mock.calls.find(([c])=>c.constructor.name==='PutObjectCommand')![0].input;
    expect(put.Key).toBe(`personal-labs/artifacts/${jobId}/extracted.json`);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(mock.textract.mock.invocationCallOrder[0]);
  });
  test('withdrawn consent stops before the provider is called and fails as consent_withdrawn',async()=>{
    const verify=vi.fn(async()=>{throw new LabAuthorizationRevoked();});mock.db.mockResolvedValueOnce({Item:job({authorization})});
    await expect(createAwsLabAnalysisWorker({jobId,pass:0},{policy:{verify}})).rejects.toThrow('consent_withdrawn');
    expect(mock.textract).not.toHaveBeenCalled();expect(mock.s3).not.toHaveBeenCalled();
  });
  test('a consent database outage is retryable, not a revocation',async()=>{
    const verify=vi.fn(async()=>{throw new Error('identity database offline');});mock.db.mockResolvedValueOnce({Item:job({authorization})});
    await expect(createAwsLabAnalysisWorker({jobId,pass:0},{policy:{verify}})).rejects.toThrow('provider_unavailable');
    expect(mock.textract).not.toHaveBeenCalled();
  });
  test('a production worker refuses an unauthorized job and a synthetic worker refuses an authorized one',async()=>{
    mock.db.mockResolvedValueOnce({Item:job()});
    await expect(createAwsLabAnalysisWorker({jobId,pass:0},{policy:{verify:vi.fn(async()=>{})}})).rejects.toThrow('consent_withdrawn');
    mock.db.mockResolvedValueOnce({Item:job({authorization})});
    await expect(createAwsLabAnalysisWorker({jobId,pass:0})).rejects.toThrow('consent_withdrawn');
    expect(mock.textract).not.toHaveBeenCalled();
  });
  test('withholds the final result when consent is withdrawn while the model worked',async()=>{
    let calls=0;const verify=vi.fn(async()=>{if(++calls>=3)throw new LabAuthorizationRevoked();});
    mock.db.mockResolvedValueOnce({Item:job({authorization,state:'interpreting',passesCompleted:4,structuredBiomarkers:[]})});
    const interpreted={biomarkers:[{canonicalName:'Fictional',reportedName:'Fictional',value:1,unit:'widgets',labMin:null,labMax:null,functionalMin:null,functionalMax:null,
      sourceId:null,sourceVersion:null,population:null,confidence:99,documentId:uuid,page:1,status:'normal'}]};
    mock.s3.mockImplementation(async c=>c.constructor.name==='GetObjectCommand'?{Body:{transformToString:async()=>JSON.stringify(interpreted)}}:{});
    mock.openai.mockResolvedValue({summary:'Fictional.',uncertainty:'Fictional.',relationshipFindings:[],priorityActions:[],citations:[],referencedBiomarkerIds:[],longitudinalSummary:'',planImpact:{headline:'Fictional.',changes:[]},providerModel:'fictional-model',
      generatedPlan:{title:'Fictional plan',summary:'Fictional.',confidence:0.5,tasks:[]}});
    await expect(createAwsLabAnalysisWorker({jobId,pass:4},{policy:{verify}})).rejects.toThrow('consent_withdrawn');
    const stored=mock.db.mock.calls.filter(([c])=>c.constructor.name==='UpdateCommand'&&String(c.input.UpdateExpression).includes('#result'));
    expect(stored).toHaveLength(0);
  });
  test('accepts consent_withdrawn as a recorded failure category',async()=>{
    mock.db.mockResolvedValueOnce({});
    expect(await createAwsLabAnalysisWorker({jobId,pass:0,fail:true,failureCategory:'consent_withdrawn'})).toMatchObject({failed:true});
    expect(mock.db.mock.calls[0][0].input.ExpressionAttributeValues[':category']).toBe('consent_withdrawn');
  });
});
