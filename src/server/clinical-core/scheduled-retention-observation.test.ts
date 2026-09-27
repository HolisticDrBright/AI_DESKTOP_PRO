import {readFileSync} from 'node:fs';
import {describe,expect,test} from 'vitest';
import {observeScheduledRetentionRemoval} from './scheduled-retention-observation';
import {retentionScheduleInvocation} from './privacy-retention-sweep-lambda';
import {validateQualificationTargetManifest} from './qualification-target-manifest';
const manifest=validateQualificationTargetManifest({...JSON.parse(readFileSync('infra/aws-clinical-core/qualification-target.example.json','utf8')),
  exportBucket:'fictional-exports',recordingBucket:'fictional-recordings',sourceCommit:'a'.repeat(40),migrationReleaseHash:'b'.repeat(64),
  databaseSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCdEf',
  identitySubjects:{consumer:'fictional-consumer',foreignConsumer:'fictional-second',workforce:'fictional-workforce',retentionService:'svc-fictional-retention'}});
const job='11111111-1111-4111-8111-111111111111',request='22222222-2222-4222-8222-222222222222';
const fn=`${manifest.apiId}-privacy-retention-sweep`,ruleArn=`arn:aws:events:us-east-2:588966314750:rule/${fn}`;
const functionArn=`arn:aws:lambda:us-east-2:588966314750:function:${fn}`;
const since='2026-09-27T10:00:00.000Z',startedAt='2026-09-27T10:00:01.000Z',endedAt='2026-09-27T10:00:05.000Z';
const event={source:'aws.events','detail-type':'Scheduled Event',resources:[ruleArn],id:job};
const evidence=()=>({ok:true,refused:null,invocation:retentionScheduleInvocation(event,request,ruleArn),run:{startedAt,endedAt,removed:1,outcome:'completed'}});
function fixture(options:{log?:unknown;audit?:boolean;stream?:string;rule?:Record<string,unknown>;database?:string}={}){
  const calls:string[][]=[];
  const aws=async(args:string[])=>{
    calls.push(args);
    if(args[0]==='events'&&args[1]==='describe-rule')return {Arn:ruleArn,State:'ENABLED',ScheduleExpression:'rate(24 hours)',...options.rule};
    if(args[0]==='events')return {Targets:[{Arn:functionArn}]};
    if(args[0]==='lambda')return {FunctionArn:functionArn,State:'Active',LastUpdateStatus:'Successful',LoggingConfig:{LogGroup:`/aws/lambda/${manifest.apiId}-privacy-operations`},
      Environment:{Variables:{PHI_ALLOWED:'false',SOURCE_COMMIT:manifest.sourceCommit,RETENTION_SCHEDULE_ARN:ruleArn,RETENTION_SERVICE_SUBJECT:manifest.identitySubjects.retentionService,CLINICAL_DATABASE_NAME:options.database??manifest.databaseName}}};
    if(args[0]==='logs')return {events:[{message:JSON.stringify(options.log??evidence()),logStreamName:options.stream??`2026/09/27/${fn}[$LATEST][fictional]`}]};
    if(args[0]==='rds-data')return {records:[[{booleanValue:options.audit??true}]]};
    throw new Error('unexpected_read');
  };
  return {calls,aws};
}
const run=(f:ReturnType<typeof fixture>)=>observeScheduledRetentionRemoval(manifest,job,since,f.aws,Date.parse(endedAt)+1000);
describe('scheduled export removal attribution',()=>{
  test('requires a scheduled invocation in the correct function stream plus this job service audit',async()=>{
    const f=fixture();expect(await run(f)).toBe(true);
    const db=f.calls.find(c=>c[0]==='rds-data')!;
    expect(db[db.indexOf('--database')+1]).toBe('clinical_core_qualification');
    expect(db[db.indexOf('--sql')+1]).toContain("e.action='object.deleted'");
    expect(db[db.indexOf('--sql')+1]).not.toContain(job);
    expect(JSON.parse(db[db.indexOf('--parameters')+1])).toContainEqual({name:'job',value:{stringValue:job}});
    expect(f.calls.every(c=>!c.includes('invoke')&&!c.includes('put-events'))).toBe(true);
  });
  test('owner deletion or a different job never counts',async()=>{expect(await run(fixture({audit:false}))).toBe(false);});
  test('missing, failed, stale, unrelated and non-removing logs never count',async()=>{
    for(const log of [{}, {...evidence(),ok:false},{...evidence(),invocation:{...evidence().invocation,ruleArn:ruleArn+'other'}},
      {...evidence(),run:{...evidence().run,removed:0}},{...evidence(),run:{...evidence().run,startedAt:'2026-09-26T00:00:00Z'}},
      {...evidence(),run:{...evidence().run,outcome:'refused'}}]){
      const f=fixture({log});expect(await run(f)).toBe(false);expect(f.calls.some(c=>c[0]==='rds-data')).toBe(false);
    }
    expect(await run(fixture({stream:'2026/09/27/another-function[$LATEST][fictional]'}))).toBe(false);
  });
  test('wrong database, disabled schedule and production targets are refused',async()=>{
    await expect(run(fixture({database:'clinical_core'}))).rejects.toThrow('scheduled_retention_observation_refused');
    await expect(run(fixture({rule:{State:'DISABLED'}}))).rejects.toThrow('scheduled_retention_observation_refused');
    const f=fixture();await expect(observeScheduledRetentionRemoval({...manifest,awsAccountId:'173535830222'},job,since,f.aws)).rejects.toThrow();expect(f.calls).toHaveLength(0);
  });
  test('runtime rejects manual or wrong-rule event shapes before storage work',()=>{
    expect(retentionScheduleInvocation(event,request,ruleArn).source).toBe('aws.events');
    for(const invalid of [null,{}, {...event,source:'manual'},{...event,resources:[ruleArn+'other']},{...event,id:'bad'}]){
      expect(()=>retentionScheduleInvocation(invalid,request,ruleArn)).toThrow('retention_schedule_trigger_refused');
    }
  });
});
