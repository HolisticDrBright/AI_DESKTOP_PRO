import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CANDIDATES,loadTemplate} from './build-aws-qualification-parameters.mjs';

// The historical parameter-example registry still owns ten source-independent
// examples. Messaging pins its exact source SHA and is built separately, but its
// messaging and connection reservations must not disappear from fleet preflight.
export const CAPACITY_CANDIDATES = [...Object.keys(CANDIDATES),'care-messaging','care-connections'];
export function assertCapacityPrincipal(identity) {
  if(identity?.Account !== '588966314750' || typeof identity?.Arn !== 'string'
    || !/^arn:aws:sts::588966314750:assumed-role\/[A-Za-z0-9_+=,.@/-]+$/.test(identity.Arn)) throw new Error('synthetic_assumed_role_required');
}
export function loadCapacityTemplate(candidateName) {
  if(!['care-messaging','care-connections'].includes(candidateName))return loadTemplate(candidateName);
  const prefix=`qualification-${candidateName}-capacity-`;
  const directory=mkdtempSync(join(tmpdir(),prefix));
  try {
    execFileSync(process.execPath,[`scripts/build-aws-${candidateName}.mjs`,'--out-dir='+directory],{stdio:'pipe',timeout:60_000,windowsHide:true});
    return JSON.parse(readFileSync(join(directory,'template.json'),'utf8'));
  } finally {
    const target=resolve(directory);
    if(dirname(target)!==resolve(tmpdir()) || !basename(target).startsWith(prefix))throw new Error('temporary_cleanup_boundary_refused');
    rmSync(target,{recursive:true,force:true});
  }
}

/** Conservative preflight, not a capacity guarantee. AWS documents a 100-unit unreserved floor.
 * Reduced-quota accounts can have a lower floor, but never silently remove the candidate caps. */
export function assessCapacity(limits, functions) {
  const natural = n => Number.isSafeInteger(n) && n >= 0;
  if (!natural(limits?.ConcurrentExecutions) || !natural(limits?.UnreservedConcurrentExecutions)
    || limits.UnreservedConcurrentExecutions > limits.ConcurrentExecutions || !Array.isArray(functions) || !functions.length) throw new Error('capacity_observation_invalid');
  const names = new Set();
  let additional = 0, desired = 0;
  for (const f of functions) {
    if (typeof f.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f.name) || names.has(f.name)
      || !natural(f.desired) || !natural(f.existing)) throw new Error('capacity_observation_invalid');
    names.add(f.name); desired += f.desired;
    // Do not credit a planned reduction before AWS has actually released it.
    additional += Math.max(0, f.desired - f.existing);
  }
  const unreservedFloor = 100;
  return {mode:'qualification_capacity_preflight',positiveHostedAcceptance:false,mutations:false,
    totalLimit:limits.ConcurrentExecutions,unreserved:limits.UnreservedConcurrentExecutions,
    requestedReserved:desired,additionalReserved:additional,unreservedFloor,
    minimumTotalWithCurrentReservations:limits.ConcurrentExecutions-limits.UnreservedConcurrentExecutions+additional+unreservedFloor,
    ready:limits.UnreservedConcurrentExecutions-additional>=unreservedFloor};
}

export function reservedFunctions(template, apiId) {
  if (!/^[a-z0-9]{10}$/.test(apiId)) throw new Error('api_id_invalid');
  return Object.entries(template.Resources ?? {}).filter(([,r])=>r.Type==='AWS::Lambda::Function'&&r.Properties?.ReservedConcurrentExecutions!==undefined).map(([logicalId,r])=>{
    const raw=r.Properties.FunctionName;
    if(raw===undefined) return {name:null,logicalId,desired:r.Properties.ReservedConcurrentExecutions};
    const name=typeof raw==='string'?raw:typeof raw?.['Fn::Sub']==='string'?raw['Fn::Sub'].replaceAll('${ApiId}',apiId).replaceAll('${ClinicalApiId}',apiId):null;
    if (!name || name.includes('${') || !Number.isSafeInteger(r.Properties.ReservedConcurrentExecutions)) throw new Error('template_capacity_unresolved');
    return {name,desired:r.Properties.ReservedConcurrentExecutions};
  });
}

async function main() {
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=='--api-id'||args[2]!=='--profile')throw new Error('usage: --api-id <qualification-api> --profile <synthetic-profile>');
  const apiId=args[1],profile=args[3];
  const aws=(...parts)=>JSON.parse(execFileSync('aws',[...parts,'--profile',profile,'--region','us-east-2','--output','json'],{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']}));
  assertCapacityPrincipal(aws('sts','get-caller-identity'));
  const functions=[];
  for(const candidateName of CAPACITY_CANDIDATES) {
    const template=loadCapacityTemplate(candidateName);
    for(const f of reservedFunctions(template,apiId)) {
      // CloudFormation-generated names are unknown before creation. Count the whole
      // reservation as additional rather than credit an unobserved existing function.
      if(f.name===null) { functions.push({...f,name:`generated-${candidateName}-${f.logicalId}`,existing:0,existingObservation:'conservative_no_credit'}); continue; }
      let existing=0;
      try { existing=aws('lambda','get-function-concurrency','--function-name',f.name).ReservedConcurrentExecutions??0; }
      catch(error) { if(!String(error.stderr??'').includes('(ResourceNotFoundException)'))throw new Error('function_capacity_observation_failed'); }
      functions.push({...f,existing});
    }
  }
  const report=assessCapacity(aws('lambda','get-account-settings').AccountLimit,functions);
  console.log(JSON.stringify({...report,functions},null,2));
  if(!report.ready)process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
