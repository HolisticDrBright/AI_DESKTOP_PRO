import {describe,it,expect,vi} from 'vitest';
import {applyVoiceBackfill,planVoiceBackfill,validateVoiceBackfillPlan,voiceBackfillHash,VOICE_BACKFILL_SCOPE as scope,type BackfillAws} from './voice-watch-backfill';

const code=Buffer.alloc(32,1).toString('base64'),id='a'.repeat(64),now=()=>2000;
const item=()=>({id:{S:id},state:{S:'cleaned'},format:{S:'wav'},createdAt:{N:'1000'},nextWork:{N:'1300'},expiresAt:{N:'1999'}});
function fixture(){
  const arn=`arn:aws:lambda:${scope.region}:${scope.account}:function:fixture-function`;
  const responses:Record<string,unknown>={
    'sts get-caller-identity':{Account:scope.account},
    'cloudformation describe-stacks':{Stacks:[{StackId:`arn:aws:cloudformation:${scope.region}:${scope.account}:stack/${scope.stack}/uuid`,
      StackStatus:'UPDATE_COMPLETE',LastUpdatedTime:'2026-09-16T00:00:00Z'}]},
    'cloudformation list-stack-resources':{StackResourceSummaries:[
      {LogicalResourceId:'VoiceJobTable',ResourceType:'AWS::DynamoDB::Table',PhysicalResourceId:'fixture-table'},
      {LogicalResourceId:'VoiceJobFunction',ResourceType:'AWS::Lambda::Function',PhysicalResourceId:'fixture-function'},
      {LogicalResourceId:'TranscriptionBucket',ResourceType:'AWS::S3::Bucket',PhysicalResourceId:'fixture-bucket'},
      {LogicalResourceId:'VoiceSweepRule',ResourceType:'AWS::Events::Rule',PhysicalResourceId:'fixture-rule'}]},
    'lambda get-function-configuration':{FunctionArn:arn,CodeSha256:code,State:'Active',LastUpdateStatus:'Successful',RevisionId:'revision-1',
      Environment:{Variables:{DATA_CLASSIFICATION:'synthetic_only',PHI_ALLOWED:'false',VOICE_JOB_TABLE:'fixture-table',TRANSCRIPTION_BUCKET:'fixture-bucket'}}},
    'events describe-rule':{State:'ENABLED',ScheduleExpression:'rate(1 minute)'},
    'events list-targets-by-rule':{Targets:[{Arn:arn}]},
    'dynamodb scan':{Items:[item()]},
  };
  let stored:Record<string,unknown>|undefined=item();
  const updates:string[][]=[];
  const aws=vi.fn<BackfillAws>(async args=>{
    if(args[0]==='dynamodb'&&args[1]==='update-item'){
      updates.push(args);
      const arg=(key:string)=>args[args.indexOf(key)+1];
      const names=JSON.parse(arg('--expression-attribute-names')),values=JSON.parse(arg('--expression-attribute-values'));
      const conditions=arg('--condition-expression').split(' AND ');
      const valid=conditions.every(condition=>{
        const absent=condition.match(/^attribute_not_exists\((#f\d+)\)$/);
        if(absent)return stored?.[names[absent[1]]]===undefined;
        const compare=condition.match(/^(#f\d+) = (:v\d+)$/);
        if(!compare)throw new Error('bad_condition');
        return JSON.stringify(stored?.[names[compare[1]]])===JSON.stringify(values[compare[2]]);
      });
      if(!valid)throw Object.assign(new Error('conflict'),{name:'ConditionalCheckFailedException'});
      stored={...stored,pending:values[':work'],nextWork:values[':due']};delete stored.expiresAt;
      return {};
    }
    const value=responses[args.slice(0,2).join(' ')];
    if(value===undefined)throw new Error('unexpected_command');
    return structuredClone(value);
  });
  return {aws,responses,updates,getStored:()=>stored,setStored:(value:Record<string,unknown>|undefined)=>{stored=value;}};
}
const payload=async(f:ReturnType<typeof fixture>)=>JSON.stringify(await planVoiceBackfill(f.aws,code,now));

describe('synthetic voice cleanup watch backfill',()=>{
  it('plans without writes, owner/consent reads or fabricated cleanup evidence',async()=>{
    const f=fixture(),plan=await planVoiceBackfill(f.aws,code,now);
    expect(plan).toMatchObject({entries:[{id,state:'cleaned',expiresAt:1999}],inspected:1,skipped:0});
    expect(f.updates).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/owner|consent|lastCleanupAt|cleanupWatchVersion/);
    const scan=f.aws.mock.calls.find(([args])=>args[0]==='dynamodb')![0];
    expect(scan).toContain('--consistent-read');
    expect(scan.join(' ')).not.toMatch(/owner|inputHash|authorization/);
  });
  it('requeues an existing expired-TTL row conditionally without claiming a cleanup or changing readability',async()=>{
    const f=fixture(),serialized=await payload(f);
    expect(await applyVoiceBackfill(f.aws,serialized,voiceBackfillHash(serialized),now)).toEqual({scheduled:1,changedOrMissing:0,cleanupVerified:false});
    expect(f.getStored()).toEqual({id:{S:id},state:{S:'cleaned'},format:{S:'wav'},createdAt:{N:'1000'},nextWork:{N:'2000'},pending:{S:'work'}});
    expect(f.updates[0].join(' ')).not.toMatch(/lastCleanupAt =|cleanupWatchVersion =|delete-item|put-item/);
    expect(await applyVoiceBackfill(f.aws,serialized,voiceBackfillHash(serialized),now)).toMatchObject({scheduled:0,changedOrMissing:1});
  });
  it.each(['missing','state','format','lease','due','ttl','pending'])('does not overwrite %s changed after review',async change=>{
    const f=fixture(),serialized=await payload(f);
    const row:Record<string,unknown>=item();
    if(change==='state')row.state={S:'ready'};
    if(change==='format')row.format={S:'mp4'};
    if(change==='lease')row.leaseToken={S:'new-lease'};
    if(change==='due')row.nextWork={N:'1400'};
    if(change==='ttl')row.expiresAt={N:'3000'};
    if(change==='pending')row.pending={S:'work'};
    f.setStored(change==='missing'?undefined:row);
    expect(await applyVoiceBackfill(f.aws,serialized,voiceBackfillHash(serialized),now)).toMatchObject({scheduled:0,changedOrMissing:1});
    expect(f.getStored()).toEqual(change==='missing'?undefined:row);
  });
  it('skips live, watched, partial-watch and leased records',async()=>{
    const f=fixture();
    f.responses['dynamodb scan']={Items:[
      {...item(),state:{S:'ready'}},
      {...item(),id:{S:'b'.repeat(64)},pending:{S:'work'}},
      {...item(),id:{S:'c'.repeat(64)},lastCleanupAt:{N:'1300'}},
      {...item(),id:{S:'d'.repeat(64)},leaseUntil:{N:'500'}},
    ]};
    expect(await planVoiceBackfill(f.aws,code,now)).toMatchObject({entries:[],inspected:4,skipped:4});
  });
  it.each(['duplicate','truncated','malformed'])('rejects %s scan output',async kind=>{
    const f=fixture();
    f.responses['dynamodb scan']=kind==='duplicate'?{Items:[item(),item()]}:kind==='truncated'?{Items:[item()],LastEvaluatedKey:{id:{S:id}}}
      :{Items:[{...item(),nextWork:{N:'NaN'}}]};
    await expect(planVoiceBackfill(f.aws,code,now)).rejects.toThrow();expect(f.updates).toEqual([]);
  });
  it.each(['account','code','phi','schedule','target','resource'])('refuses incorrect %s scope/configuration before writing',async kind=>{
    const f=fixture();
    if(kind==='account')f.responses['sts get-caller-identity']={Account:'173535830222'};
    if(kind==='code')f.responses['lambda get-function-configuration']={...(f.responses['lambda get-function-configuration'] as object),CodeSha256:Buffer.alloc(32,2).toString('base64')};
    if(kind==='phi')f.responses['lambda get-function-configuration']={...(f.responses['lambda get-function-configuration'] as object),Environment:{Variables:{PHI_ALLOWED:'true'}}};
    if(kind==='schedule')f.responses['events describe-rule']={State:'DISABLED',ScheduleExpression:'rate(1 minute)'};
    if(kind==='target')f.responses['events list-targets-by-rule']={Targets:[]};
    if(kind==='resource')f.responses['cloudformation list-stack-resources']={StackResourceSummaries:[]};
    await expect(planVoiceBackfill(f.aws,code,now)).rejects.toThrow();expect(f.updates).toEqual([]);
  });
  it('rejects altered approvals, stale/future plans, duplicate entries and changed deployment revisions',async()=>{
    const f=fixture(),serialized=await payload(f),plan=JSON.parse(serialized);
    await expect(applyVoiceBackfill(f.aws,serialized,'0'.repeat(64),now)).rejects.toThrow();
    expect(()=>validateVoiceBackfillPlan({...plan,plannedAt:2001},2000)).toThrow();
    expect(()=>validateVoiceBackfillPlan(plan,5601)).toThrow();
    expect(()=>validateVoiceBackfillPlan({...plan,entries:[...plan.entries,...plan.entries],inspected:2},2000)).toThrow();
    f.responses['lambda get-function-configuration']={...(f.responses['lambda get-function-configuration'] as object),RevisionId:'revision-2'};
    await expect(applyVoiceBackfill(f.aws,serialized,voiceBackfillHash(serialized),now)).rejects.toThrow();expect(f.updates).toEqual([]);
  });
  it('stops and sanitizes an uncertain write result rather than reporting success',async()=>{
    const f=fixture(),serialized=await payload(f);
    const aws:BackfillAws=args=>args[1]==='update-item'?Promise.reject(new Error('secret transport response')):f.aws(args);
    await expect(applyVoiceBackfill(aws,serialized,voiceBackfillHash(serialized),now)).rejects.toThrow('voice_backfill_update_unconfirmed_reinspect');
  });
  it('rechecks deployment between rows and stops a partially applied plan on drift',async()=>{
    const f=fixture();
    f.responses['dynamodb scan']={Items:[item(),{...item(),id:{S:'b'.repeat(64)}}]};
    const serialized=await payload(f);
    const aws:BackfillAws=async args=>{
      const value=await f.aws(args);
      if(args[1]==='update-item')f.responses['lambda get-function-configuration']={
        ...(f.responses['lambda get-function-configuration'] as object),RevisionId:'changed-after-first-write'};
      return value;
    };
    await expect(applyVoiceBackfill(aws,serialized,voiceBackfillHash(serialized),now)).rejects.toThrow();
    expect(f.updates).toHaveLength(1);
    expect(f.getStored()?.pending).toEqual({S:'work'});
  });
});
