import {describe,it,expect,vi} from 'vitest';
import {summarizeVoiceInventory,type VoiceInventoryInput} from './owned-voice-inventory';
import {readVoiceDrainInventory,type ReadAws} from './owned-voice-inventory-reader';
const id='a'.repeat(64),other='b'.repeat(64),empty=():VoiceInventoryInput=>({jobs:[],versions:[],deleteMarkers:[],providerJobs:[]});
describe('voice shutdown inventory',()=>{
  it('counts retained cleaned metadata without calling it full erasure',()=>{
    const r=summarizeVoiceInventory({...empty(),jobs:[{id,state:'cleaned'}]});
    expect(r).toMatchObject({candidateClear:true,atomicSnapshot:false,deletionCertified:false,counts:{jobMetadata:1,uncleanJobs:0}});
    expect(JSON.stringify(r)).not.toContain(id);
  });
  it.each(['uploading','queued','running','ready','failed'])('counts %s even without pending or due-work flags',state=>{
    expect(summarizeVoiceInventory({...empty(),jobs:[{id,state}]})).toMatchObject({candidateClear:false,counts:{uncleanJobs:1}});
  });
  it('includes old versions, delete markers, orphan jobs and artifacts on cleaned rows',()=>{
    const r=summarizeVoiceInventory({...empty(),jobs:[{id,state:'cleaned',pending:'work'}],
      versions:[{Key:`personal-voice/input/${id}.wav`,VersionId:'old'}],
      deleteMarkers:[{Key:`personal-voice/output/${other}.json`,VersionId:'marker'}],
      providerJobs:[{TranscriptionJobName:`alp-personal-voice-${other}`,TranscriptionJobStatus:'COMPLETED'}]});
    expect(r).toMatchObject({candidateClear:false,counts:{cleanedStillPending:1,objectVersions:1,deleteMarkers:1,
      orphanObjectVersions:1,orphanProviderJobs:1,cleanedJobsWithArtifacts:1}});
  });
  it('fingerprints inventories regardless of listing order',()=>{
    const input={...empty(),jobs:[{id,state:'cleaned'},{id:other,state:'ready'}]};
    expect(summarizeVoiceInventory(input).fingerprint).toBe(summarizeVoiceInventory({...input,jobs:[...input.jobs].reverse()}).fingerprint);
  });
  it.each([
    {jobs:[{id,state:'invalid'}]},{jobs:[{id,state:'ready'},{id,state:'ready'}]},
    {versions:[{Key:'other-namespace/private',VersionId:'x'}]},
    {versions:[{Key:`personal-voice/input/${id}.wav`,VersionId:'x'},{Key:`personal-voice/input/${id}.wav`,VersionId:'x'}]},
    {providerJobs:[{TranscriptionJobName:'unrelated',TranscriptionJobStatus:'COMPLETED'}]},
  ])('refuses malformed, duplicate or out-of-scope records %j',patch=>{
    expect(()=>summarizeVoiceInventory({...empty(),...patch})).toThrow('voice_inventory_invalid_or_incomplete');
  });
});

const scope={account:'123456789012',region:'us-east-2',stack:'voice-fixture'};
function fixture(){
  const parameters={PhiAllowed:'false',Activation:'draining',AllowedScopes:'',CleanupEvidenceSha256:'a'.repeat(64),
    ActivationEvidenceSha256:'b'.repeat(64),ProviderEvidenceSha256:'c'.repeat(64)};
  const stack={Stacks:[{StackId:`arn:aws:cloudformation:${scope.region}:${scope.account}:stack/voice-fixture/uuid`,
    StackStatus:'UPDATE_COMPLETE',LastUpdatedTime:'2026-09-15T00:00:00Z',
    Parameters:Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}))}]};
  const configuration={State:'Active',LastUpdateStatus:'Successful',RevisionId:'revision-1',
    Environment:{Variables:{PHI_ALLOWED:'false',PERSONAL_VOICE_ACTIVATION:'draining',PERSONAL_VOICE_ALLOWED_SCOPES:'',
      VOICE_JOB_TABLE:'fixture-table',TRANSCRIPTION_BUCKET:'fixture-bucket',
      PERSONAL_VOICE_CLEANUP_EVIDENCE_SHA256:parameters.CleanupEvidenceSha256,PERSONAL_VOICE_EVIDENCE_SHA256:parameters.ActivationEvidenceSha256,
      PERSONAL_VOICE_PROVIDER_EVIDENCE_SHA256:parameters.ProviderEvidenceSha256}}};
  const responses:Record<string,unknown>={
    'sts get-caller-identity':{Account:scope.account},
    'cloudformation describe-stacks':stack,
    'cloudformation list-stack-resources':{StackResourceSummaries:[
      {LogicalResourceId:'VoiceJobTable',ResourceType:'AWS::DynamoDB::Table',PhysicalResourceId:'fixture-table'},
      {LogicalResourceId:'TranscriptionBucket',ResourceType:'AWS::S3::Bucket',PhysicalResourceId:'fixture-bucket'},
      {LogicalResourceId:'VoiceJobFunction',ResourceType:'AWS::Lambda::Function',PhysicalResourceId:'fixture-function'}]},
    'lambda get-function-configuration':configuration,
    'dynamodb scan':{Items:[]},
    's3api list-object-versions':{IsTruncated:false},
    'transcribe list-transcription-jobs':{TranscriptionJobSummaries:[]},
  };
  const aws=vi.fn<ReadAws>(async args=>structuredClone(responses[args.slice(0,2).join(' ')]));
  return {responses,aws,stack,configuration};
}
describe('read-only AWS inventory scope',()=>{
  it('refuses malformed scope before AWS access',async()=>{
    const f=fixture();
    await expect(readVoiceDrainInventory({...scope,stack:'https://not-a-stack'},f.aws)).rejects.toThrow();
    expect(f.aws).not.toHaveBeenCalled();
  });
  it('refuses truncated resource discovery',async()=>{
    const f=fixture();f.responses['cloudformation list-stack-resources']={StackResourceSummaries:[],NextToken:'next'};
    await expect(readVoiceDrainInventory(scope,f.aws)).rejects.toThrow();
    expect(f.aws.mock.calls.some(([args])=>args[0]==='dynamodb')).toBe(false);
  });
  it('checks account/stack/drain before scanning and projects only lifecycle fields',async()=>{
    const f=fixture(),r=await readVoiceDrainInventory(scope,f.aws);expect(r.candidateClear).toBe(true);
    expect(r.deletionCertified).toBe(false);
    const scan=f.aws.mock.calls.find(([args])=>args[0]==='dynamodb')![0];
    expect(scan).toContain('--consistent-read');expect(scan).not.toContain('--filter-expression');
    expect(scan).toContain('#id,#state,#pending');
    expect(f.aws.mock.calls.map(([args])=>args.slice(0,2).join(' '))).toEqual([
      'sts get-caller-identity','cloudformation describe-stacks','cloudformation list-stack-resources',
      'lambda get-function-configuration','dynamodb scan','s3api list-object-versions','transcribe list-transcription-jobs',
      'cloudformation describe-stacks','lambda get-function-configuration']);
  });
  it('refuses another AWS account without touching health resources',async()=>{
    const f=fixture();f.responses['sts get-caller-identity']={Account:'999999999999'};
    await expect(readVoiceDrainInventory(scope,f.aws)).rejects.toThrow();expect(f.aws).toHaveBeenCalledTimes(1);
  });
  it('refuses a service still accepting uploads',async()=>{
    const f=fixture();f.configuration.Environment.Variables.PERSONAL_VOICE_ACTIVATION='approved';
    await expect(readVoiceDrainInventory(scope,f.aws)).rejects.toThrow();
    expect(f.aws.mock.calls.some(([args])=>args[0]==='dynamodb')).toBe(false);
  });
  it.each([
    ['dynamodb scan',{Items:[],LastEvaluatedKey:{id:{S:id}}}],
    ['s3api list-object-versions',{IsTruncated:true}],
    ['transcribe list-transcription-jobs',{TranscriptionJobSummaries:[],NextToken:'remaining'}],
  ])('refuses an incomplete listing %s',async(key,response)=>{
    const f=fixture();f.responses[key as string]=response;
    await expect(readVoiceDrainInventory(scope,f.aws)).rejects.toThrow();
  });
  it('fails when configuration changes during the scan',async()=>{
    const f=fixture(),read=f.aws.getMockImplementation()!;let configurations=0;
    f.aws.mockImplementation(async args=>{
      const result=await read(args);
      if(args[0]==='lambda'&&++configurations===2)(result as {RevisionId:string}).RevisionId='new-revision';
      return result;
    });
    await expect(readVoiceDrainInventory(scope,f.aws)).rejects.toThrow();
  });
  it('propagates a read failure instead of reporting an empty inventory',async()=>{
    const f=fixture();f.aws.mockRejectedValueOnce(new Error('read failed'));
    await expect(readVoiceDrainInventory(scope,f.aws)).rejects.toThrow();
  });
});
