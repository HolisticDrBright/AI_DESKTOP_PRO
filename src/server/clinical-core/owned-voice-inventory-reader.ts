import {summarizeVoiceInventory} from './owned-voice-inventory';

export type InventoryScope={account:string;region:string;stack:string};
export type ReadAws=(args:string[])=>Promise<unknown>;
const fail=()=>new Error('voice_inventory_scope_or_read_refused');
function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail();
  return value as Record<string,unknown>;
}
function list(value:unknown):unknown[]{if(!Array.isArray(value)||value.length>100_000)throw fail();return value;}
function string(value:unknown):string{if(typeof value!=='string'||!value||value.length>2048)throw fail();return value;}
function attr(value:unknown){return string(record(value).S);}
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export async function readVoiceDrainInventory(scope:InventoryScope,aws:ReadAws){
  if(!/^[0-9]{12}$/.test(scope.account)||!/^us-(east|west)-[12]$/.test(scope.region)
    ||! /^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(scope.stack))throw fail();
  const identity=record(await aws(['sts','get-caller-identity']));
  if(identity.Account!==scope.account)throw fail();
  const describe=()=>aws(['cloudformation','describe-stacks','--stack-name',scope.stack]).then(value=>{
    const stacks=list(record(value).Stacks);if(stacks.length!==1)throw fail();
    const stack=record(stacks[0]);
    if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(String(stack.StackStatus))
      ||!string(stack.StackId).startsWith(`arn:aws:cloudformation:${scope.region}:${scope.account}:stack/${scope.stack}/`))throw fail();
    const entries=list(stack.Parameters).map(v=>record(v));
    const params=Object.fromEntries(entries.map(v=>[string(v.ParameterKey),v.ParameterValue]));
    if(Object.keys(params).length!==entries.length||params.PhiAllowed!=='false'||params.Activation!=='draining'
      ||params.AllowedScopes!==''||!hash(params.CleanupEvidenceSha256)||!hash(params.ActivationEvidenceSha256)||!hash(params.ProviderEvidenceSha256))throw fail();
    return {id:stack.StackId,updated:stack.LastUpdatedTime??stack.CreationTime,params};
  });
  const before=await describe();
  const resourcePage=record(await aws(['cloudformation','list-stack-resources','--stack-name',scope.stack]));
  if(resourcePage.NextToken!==undefined)throw fail();
  const resources=list(resourcePage.StackResourceSummaries).map(record);
  const resource=(logical:string,type:string)=>{
    const matches=resources.filter(r=>r.LogicalResourceId===logical&&r.ResourceType===type);
    if(matches.length!==1)throw fail();
    return string(matches[0].PhysicalResourceId);
  };
  const table=resource('VoiceJobTable','AWS::DynamoDB::Table'),bucket=resource('TranscriptionBucket','AWS::S3::Bucket'),
    fn=resource('VoiceJobFunction','AWS::Lambda::Function');
  if(!/^[a-zA-Z0-9_.-]{3,255}$/.test(table)||! /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    ||! /^[a-zA-Z0-9-_]{1,64}$/.test(fn))throw fail();
  const configuration=async()=>{
    const config=record(await aws(['lambda','get-function-configuration','--function-name',fn]));
    const vars=record(record(config.Environment).Variables);
    if(config.State!=='Active'||config.LastUpdateStatus!=='Successful'
      ||vars.PHI_ALLOWED!=='false'||vars.PERSONAL_VOICE_ACTIVATION!=='draining'||vars.PERSONAL_VOICE_ALLOWED_SCOPES!==''
      ||vars.VOICE_JOB_TABLE!==table||vars.TRANSCRIPTION_BUCKET!==bucket
      ||vars.PERSONAL_VOICE_CLEANUP_EVIDENCE_SHA256!==before.params.CleanupEvidenceSha256
      ||vars.PERSONAL_VOICE_EVIDENCE_SHA256!==before.params.ActivationEvidenceSha256
      ||vars.PERSONAL_VOICE_PROVIDER_EVIDENCE_SHA256!==before.params.ProviderEvidenceSha256)throw fail();
    return string(config.RevisionId);
  };
  const revision=await configuration();
  // AWS CLI default auto-pagination must remain enabled. Markers remaining after
  // aggregation are treated as incomplete output, never silently accepted.
  const scan=record(await aws(['dynamodb','scan','--table-name',table,'--consistent-read',
    '--projection-expression','#id,#state,#pending,cleanupWatchVersion,lastCleanupAt,nextWork,expiresAt','--expression-attribute-names',JSON.stringify({'#id':'id','#state':'state','#pending':'pending'})]));
  if(scan.NextToken!==undefined||(scan.LastEvaluatedKey!==undefined&&Object.keys(record(scan.LastEvaluatedKey)).length))throw fail();
  const jobs=list(scan.Items).map(value=>{
    const row=record(value);
    const numberAttribute=(value:unknown)=>{
      const field=record(value);
      if(Object.keys(field).join(',')!=='N'||typeof field.N!=='string'||!/^\d+$/.test(field.N)||!Number.isSafeInteger(Number(field.N)))throw fail();
      return Number(field.N);
    };
    return {id:attr(row.id),state:attr(row.state),...(row.pending===undefined?{}:{pending:attr(row.pending)}),
      ...(row.cleanupWatchVersion===undefined?{}:{cleanupWatchVersion:attr(row.cleanupWatchVersion)}),
      ...Object.fromEntries(['lastCleanupAt','nextWork','expiresAt'].filter(key=>row[key]!==undefined).map(key=>[key,numberAttribute(row[key])]))};
  });
  const objects=record(await aws(['s3api','list-object-versions','--bucket',bucket,'--expected-bucket-owner',scope.account,'--prefix','personal-voice/']));
  if(objects.IsTruncated===true||objects.NextKeyMarker!==undefined||objects.NextVersionIdMarker!==undefined||objects.NextToken!==undefined)throw fail();
  const providers=record(await aws(['transcribe','list-transcription-jobs','--job-name-contains','alp-personal-voice-']));
  if(providers.NextToken!==undefined)throw fail();
  const report=summarizeVoiceInventory({jobs,versions:objects.Versions===undefined?[]:list(objects.Versions),
    deleteMarkers:objects.DeleteMarkers===undefined?[]:list(objects.DeleteMarkers),providerJobs:list(providers.TranscriptionJobSummaries)});
  const after=await describe();
  if(JSON.stringify(after)!==JSON.stringify(before)||await configuration()!==revision)throw fail();
  return {scope,configurationRevision:revision,...report,
    caveat:'Read-only non-atomic inventory. Stop old writers and independently reconcile repeated inventories before blocking cleanup. No erasure certification.'};
}
