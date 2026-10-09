import type { QualificationTargetManifest } from './qualification-target-manifest';

type AwsRead = (args:string[]) => Promise<unknown>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=()=>new Error('scheduled_retention_observation_refused');
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail();
  return value as Record<string,unknown>;
}

/** Read-only, qualification-only observation. The CLI first verifies the live stacks against this manifest.
 * A deleted status alone cannot attribute removal. Require a completed scheduled invocation in the deployed
 * function's log stream AND a deletion audit for this job, attributed to the designated service inside that run.
 * No object contents, owners or credentials leave this reader. Log delivery lag returns false, not a pass.
 * This is operational correlation, not protection against an administrator fabricating cloud evidence. */
export async function observeScheduledRetentionRemoval(manifest:QualificationTargetManifest,jobId:string,since:string,aws:AwsRead,now=Date.now()):Promise<boolean>{
  const start=Date.parse(since),subject=manifest.identitySubjects.retentionService;
  if(manifest.awsAccountId!=='588966314750'||manifest.databaseName!=='clinical_core_qualification'
    ||manifest.containsPhi!==false||!UUID.test(jobId)||!Number.isFinite(start)||start>now
    ||typeof subject!=='string'||!/^svc-[a-z0-9][a-z0-9-]{2,60}$/.test(subject))throw fail();
  const ruleName=`${manifest.apiId}-privacy-retention-sweep`;
  const ruleArn=`arn:aws:events:${manifest.awsRegion}:${manifest.awsAccountId}:rule/${ruleName}`;
  const rule=object(await aws(['events','describe-rule','--name',ruleName]));
  if(rule.Arn!==ruleArn||rule.State!=='ENABLED'||rule.ScheduleExpression!=='rate(24 hours)')throw fail();
  const functionArn=`arn:aws:lambda:${manifest.awsRegion}:${manifest.awsAccountId}:function:${ruleName}`;
  const targets=object(await aws(['events','list-targets-by-rule','--rule',ruleName]));
  if(targets.NextToken||!Array.isArray(targets.Targets)||targets.Targets.length!==1||object(targets.Targets[0]).Arn!==functionArn)throw fail();
  const configuration=object(await aws(['lambda','get-function-configuration','--function-name',ruleName]));
  const env=object(object(configuration.Environment).Variables);
  const logGroup=object(configuration.LoggingConfig).LogGroup;
  if(configuration.FunctionArn!==functionArn||configuration.State!=='Active'||configuration.LastUpdateStatus!=='Successful'
    ||configuration.ReservedConcurrentExecutions===0||env.RETENTION_SCHEDULE_ARN!==ruleArn
    ||env.PHI_ALLOWED!=='false'||env.SOURCE_COMMIT!==manifest.sourceCommit||env.RETENTION_SERVICE_SUBJECT!==subject
    ||env.CLINICAL_DATABASE_NAME!==manifest.databaseName||typeof logGroup!=='string'||!logGroup.startsWith('/aws/lambda/'))throw fail();
  const logs=object(await aws(['logs','filter-log-events','--log-group-name',logGroup,'--start-time',String(start),
    '--end-time',String(now),'--filter-pattern','"aws.events"']));
  if(logs.nextToken||!Array.isArray(logs.events)||logs.events.length>10_000)throw fail();
  for(const raw of logs.events){
    const entry=object(raw);
    if(typeof entry.message!=='string'||entry.message.length>32_768||typeof entry.logStreamName!=='string'
      ||!entry.logStreamName.includes(`/${ruleName}[$LATEST]`))continue;
    let value:Record<string,unknown>;
    try{value=object(JSON.parse(entry.message));}catch{continue;}
    if(value.ok!==true||value.refused!==null||!value.invocation||!value.run)continue;
    const invocation=object(value.invocation),run=object(value.run);
    const began=Date.parse(String(run.startedAt)),ended=Date.parse(String(run.endedAt));
    if(invocation.source!=='aws.events'||invocation.ruleArn!==ruleArn||!UUID.test(String(invocation.eventId))||!UUID.test(String(invocation.requestId))
      ||run.outcome!=='completed'||!Number.isSafeInteger(run.removed)||Number(run.removed)<1
      ||!Number.isFinite(began)||!Number.isFinite(ended)||began<start||ended<began||ended>now||ended-began>600_000)continue;
    const parameters=JSON.stringify([{name:'job',value:{stringValue:jobId}},{name:'subject',value:{stringValue:subject}},
      {name:'start',value:{stringValue:new Date(began).toISOString()}},{name:'end',value:{stringValue:new Date(ended).toISOString()}}]);
    // Single bounded EXISTS read; never an open transaction around cloud calls. Parameters are not interpolated SQL.
    const sql=`select exists(select 1 from clinical_private.owned_privacy_export_jobs j
      join clinical_audit.owned_privacy_export_events e on e.export_id=j.export_id and e.owner_id=j.owner_id
      join clinical_private.privacy_retention_service_releases r on r.service_person_id=e.operator_id
      where j.id=cast(:job as uuid) and j.object_deleted_at is not null and e.action='object.deleted'
      and r.identity_subject=:subject and r.approved_at<=e.recorded_at and (r.revoked_at is null or r.revoked_at>e.recorded_at)
      and e.recorded_at>=cast(:start as timestamptz) and e.recorded_at<=cast(:end as timestamptz)) as matched`;
    const result=object(await aws(['rds-data','execute-statement','--resource-arn',manifest.databaseClusterArn,'--secret-arn',manifest.databaseSecretArn,
      '--database',manifest.databaseName,'--sql',sql,'--parameters',parameters]));
    const rows=result.records;
    if(!Array.isArray(rows)||rows.length!==1||!Array.isArray(rows[0])||rows[0].length!==1)throw fail();
    const field=object(rows[0][0]);
    if(typeof field.booleanValue!=='boolean'||Object.keys(field).length!==1)throw fail();
    if(field.booleanValue)return true;
  }
  return false;
}
