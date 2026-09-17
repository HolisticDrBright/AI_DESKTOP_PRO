import {createHash} from 'node:crypto';
import {z} from 'zod';

// Administrative tool only. No runtime route, new role grants or production mode.
export const VOICE_BACKFILL_SCOPE={account:'588966314750',region:'us-east-2',stack:'ai-clinical-core-synthetic-staging-chat-transcription'} as const;
export type BackfillAws=(args:string[])=>Promise<unknown>;
const error=()=>new Error('voice_backfill_refused');
const object=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw error();
  return value as Record<string,unknown>;
};
const array=(value:unknown):unknown[]=>{if(!Array.isArray(value)||value.length>10000)throw error();return value;};
const text=(value:unknown)=>{if(typeof value!=='string'||!value||value.length>2048)throw error();return value;};
const seconds=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rowSchema=z.object({
  id:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['uploading','queued','running','ready','failed','cleaned']),
  format:z.enum(['wav','mp4']),createdAt:seconds,nextWork:seconds,
  pending:z.literal('work').optional(),expiresAt:seconds.optional(),
  leaseToken:z.string().min(1).max(128).optional(),leaseUntil:seconds.optional(),
  cleanupWatchVersion:z.literal('voice-cleanup-watch/1').optional(),lastCleanupAt:seconds.optional(),
}).strict();
type Row=z.infer<typeof rowSchema>;
const fields=['id','state','format','createdAt','nextWork','pending','expiresAt','leaseToken','leaseUntil','cleanupWatchVersion','lastCleanupAt'] as const;
const names=Object.fromEntries(fields.map((field,i)=>['#f'+i,field]));
const projection=fields.map((_,i)=>'#f'+i).join(',');
function decode(input:unknown):Row{
  const raw=object(input),result:Record<string,unknown>={};
  if(Object.keys(raw).some(key=>!fields.includes(key as typeof fields[number])))throw error();
  for(const [key,value] of Object.entries(raw)){
    const attr=object(value),keys=Object.keys(attr);
    if(keys.length!==1)throw error();
    if(keys[0]==='S')result[key]=text(attr.S);
    else if(keys[0]==='N'&&typeof attr.N==='string'&&/^\d+$/.test(attr.N))result[key]=Number(attr.N);
    else throw error();
  }
  return rowSchema.parse(result);
}
const attribute=(value:string|number)=>typeof value==='number'?{N:String(value)}:{S:value};
const digest=z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const configurationSchema=z.object({
  stackId:z.string().min(1),stackTime:z.string().min(1),table:z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
  functionName:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),revision:z.string().min(1),codeSha256:digest,
}).strict();
const planSchema=z.object({
  version:z.literal('voice-watch-backfill/1'),scope:z.object({account:z.literal(VOICE_BACKFILL_SCOPE.account),
    region:z.literal(VOICE_BACKFILL_SCOPE.region),stack:z.literal(VOICE_BACKFILL_SCOPE.stack)}).strict(),
  plannedAt:seconds,configuration:configurationSchema,entries:z.array(rowSchema).max(10000),
  inspected:seconds,skipped:seconds,
}).strict();
export type VoiceBackfillPlan=z.infer<typeof planSchema>;
export const voiceBackfillHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const eligible=(row:Row,now:number)=>row.state==='cleaned'&&row.pending===undefined
  &&row.cleanupWatchVersion===undefined&&row.lastCleanupAt===undefined&&row.createdAt<=now
  &&row.leaseToken===undefined&&row.leaseUntil===undefined;

async function configuration(aws:BackfillAws,expectedCode:string){
  digest.parse(expectedCode);
  if(object(await aws(['sts','get-caller-identity'])).Account!==VOICE_BACKFILL_SCOPE.account)throw error();
  const stacks=array(object(await aws(['cloudformation','describe-stacks','--stack-name',VOICE_BACKFILL_SCOPE.stack])).Stacks);
  if(stacks.length!==1)throw error();
  const stack=object(stacks[0]);
  const prefix=`arn:aws:cloudformation:${VOICE_BACKFILL_SCOPE.region}:${VOICE_BACKFILL_SCOPE.account}:stack/${VOICE_BACKFILL_SCOPE.stack}/`;
  if(!text(stack.StackId).startsWith(prefix)||!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(String(stack.StackStatus)))throw error();
  const page=object(await aws(['cloudformation','list-stack-resources','--stack-name',VOICE_BACKFILL_SCOPE.stack]));
  if(page.NextToken!==undefined)throw error();
  const resources=array(page.StackResourceSummaries).map(object);
  const resource=(logical:string,type:string)=>{
    const matches=resources.filter(r=>r.LogicalResourceId===logical&&r.ResourceType===type);
    if(matches.length!==1)throw error();return text(matches[0].PhysicalResourceId);
  };
  const table=resource('VoiceJobTable','AWS::DynamoDB::Table');
  const fn=resource('VoiceJobFunction','AWS::Lambda::Function');
  const bucket=resource('TranscriptionBucket','AWS::S3::Bucket');
  const rule=resource('VoiceSweepRule','AWS::Events::Rule');
  const config=object(await aws(['lambda','get-function-configuration','--function-name',fn]));
  const env=object(object(config.Environment).Variables);
  const functionArn=`arn:aws:lambda:${VOICE_BACKFILL_SCOPE.region}:${VOICE_BACKFILL_SCOPE.account}:function:${fn}`;
  if(config.FunctionArn!==functionArn||config.State!=='Active'||config.LastUpdateStatus!=='Successful'
    ||config.CodeSha256!==expectedCode||env.DATA_CLASSIFICATION!=='synthetic_only'||env.PHI_ALLOWED!=='false'
    ||env.VOICE_JOB_TABLE!==table||env.TRANSCRIPTION_BUCKET!==bucket)throw error();
  const schedule=object(await aws(['events','describe-rule','--name',rule]));
  if(schedule.State!=='ENABLED'||schedule.ScheduleExpression!=='rate(1 minute)')throw error();
  const targets=object(await aws(['events','list-targets-by-rule','--rule',rule]));
  if(targets.NextToken!==undefined||!array(targets.Targets).some(t=>object(t).Arn===functionArn))throw error();
  return configurationSchema.parse({stackId:stack.StackId,stackTime:stack.LastUpdatedTime??stack.CreationTime,
    table,functionName:fn,revision:config.RevisionId,codeSha256:config.CodeSha256});
}

export function validateVoiceBackfillPlan(input:unknown,now:number){
  seconds.parse(now);
  const plan=planSchema.parse(input);
  if(plan.plannedAt>now||now-plan.plannedAt>3600||plan.inspected>10000
    ||plan.entries.length+plan.skipped!==plan.inspected
    ||new Set(plan.entries.map(row=>row.id)).size!==plan.entries.length
    ||plan.entries.some(row=>!eligible(row,plan.plannedAt)))throw error();
  return plan;
}

/** Default/read-only stage. Project lifecycle metadata, never owners or recordings. */
export async function planVoiceBackfill(aws:BackfillAws,expectedCode:string,now=()=>Math.floor(Date.now()/1000)){
  const plannedAt=now(),before=await configuration(aws,expectedCode);
  const page=object(await aws(['dynamodb','scan','--table-name',before.table,'--consistent-read',
    '--projection-expression',projection,'--expression-attribute-names',JSON.stringify(names)]));
  // CLI auto-pagination must stay enabled. Partial, malformed or duplicate results refuse.
  if(page.NextToken!==undefined||(page.LastEvaluatedKey!==undefined&&Object.keys(object(page.LastEvaluatedKey)).length))throw error();
  const rows=array(page.Items).map(decode);
  if(new Set(rows.map(row=>row.id)).size!==rows.length)throw error();
  const entries=rows.filter(row=>eligible(row,plannedAt)).sort((a,b)=>a.id.localeCompare(b.id));
  if(!same(before,await configuration(aws,expectedCode)))throw error();
  return validateVoiceBackfillPlan({version:'voice-watch-backfill/1',scope:VOICE_BACKFILL_SCOPE,plannedAt,
    configuration:before,entries,inspected:rows.length,skipped:rows.length-entries.length},now());
}

/** Explicit apply only. A reviewed plan never grants authority to recreate a missing row. */
export async function applyVoiceBackfill(aws:BackfillAws,serialized:string,approvedHash:string,now=()=>Math.floor(Date.now()/1000)){
  if(!/^[a-f0-9]{64}$/.test(approvedHash)||voiceBackfillHash(serialized)!==approvedHash)throw error();
  const plan=validateVoiceBackfillPlan(JSON.parse(serialized),now());
  const check=async()=>{
    validateVoiceBackfillPlan(plan,now());
    if(!same(plan.configuration,await configuration(aws,plan.configuration.codeSha256)))throw error();
  };
  await check();
  const result={scheduled:0,changedOrMissing:0,cleanupVerified:false};
  for(const row of plan.entries){
    await check();
    const values:Record<string,unknown>={':work':{S:'work'},':due':{N:String(now())}};
    const conditions=fields.map((field,i)=>{
      const value=row[field];
      if(value===undefined)return `attribute_not_exists(#f${i})`;
      values[':v'+i]=attribute(value);return `#f${i} = :v${i}`;
    });
    try{
      await aws(['dynamodb','update-item','--table-name',plan.configuration.table,'--key',JSON.stringify({id:{S:row.id}}),
        '--condition-expression',conditions.join(' AND '),
        '--update-expression','SET #f5 = :work, #f4 = :due REMOVE #f6',
        '--expression-attribute-names',JSON.stringify(names),'--expression-attribute-values',JSON.stringify(values)]);
      result.scheduled++;
    }catch(caught){
      if(caught instanceof Error&&caught.name==='ConditionalCheckFailedException'){result.changedOrMissing++;continue;}
      throw new Error('voice_backfill_update_unconfirmed_reinspect');
    }
  }
  await check();
  return result;
}
