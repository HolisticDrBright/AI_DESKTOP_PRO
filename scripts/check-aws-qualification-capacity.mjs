import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CANDIDATES} from './build-aws-qualification-parameters.mjs';

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
  if(aws('sts','get-caller-identity').Account!=='588966314750')throw new Error('synthetic_account_required');
  const functions=[];
  for(const [candidateName,candidate] of Object.entries(CANDIDATES)) {
    const template=JSON.parse(readFileSync(resolve(candidate.template),'utf8'));
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
