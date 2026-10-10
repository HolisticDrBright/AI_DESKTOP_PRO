if(typeof window!=='undefined')throw Error('Fullscript deployment controls are server-only.');
import {deploymentCanonical,type DeploymentObservation,type DeploymentPlan} from './qualification-deployment-execution';
type Obj=Record<string,unknown>;
export type FullscriptInstalledControls={role:Obj;inline:Obj;policyNames:Obj;attached:Obj;lambdaPolicy:Obj;concurrency:Obj;logs:Obj;alarms:Obj};
const fail=():never=>{throw Error('fullscript_deployment_controls_refused');};
function check(v:unknown):asserts v{if(!v)fail();}
const obj=(v:unknown):Obj=>{check(v&&typeof v==='object'&&!Array.isArray(v));return v as Obj;};
const same=(a:unknown,b:unknown)=>deploymentCanonical(a)===deploymentCanonical(b);
const absent=Symbol('CloudFormation NoValue');
function physical(o:DeploymentObservation,id:string){const r=o.resources.filter(r=>r.LogicalResourceId===id);check(r.length===1&&typeof r[0].PhysicalResourceId==='string');return r[0].PhysicalResourceId as string;}
/** Resolve only the intrinsics the reviewed candidate actually uses. Unknown
 * syntax is a refusal, never a wildcard or guessed resource. */
function resolver(plan:DeploymentPlan){
 const values=Object.fromEntries(plan.parameters.map(p=>[p.ParameterKey,p.ParameterValue]));
 function resolve(v:unknown):unknown{
  if(Array.isArray(v))return v.map(resolve).filter(x=>x!==absent);
  if(!v||typeof v!=='object')return v;
  const r=obj(v),keys=Object.keys(r);
  if(keys.length===1&&'Ref' in r){check(typeof r.Ref==='string');if(r.Ref==='AWS::NoValue')return absent;check(Object.hasOwn(values,r.Ref));return values[r.Ref];}
  if(keys.length===1&&'Fn::Sub' in r){check(typeof r['Fn::Sub']==='string');return r['Fn::Sub'].replace(/\$\{([^}]+)\}/g,(_whole,key)=>{check(Object.hasOwn(values,key));return values[key];});}
  if(keys.length===1&&'Fn::If' in r){const args=r['Fn::If'];check(Array.isArray(args)&&args.length===3&&['ProviderKey','DatabaseKey'].includes(String(args[0])));
   const key=String(args[0]).replace('Key','SecretKmsKeyArn');check(Object.hasOwn(values,key));return resolve(args[values[key]?1:2]);}
  check(!keys.some(k=>k==='Ref'||k.startsWith('Fn::')));return Object.fromEntries(keys.map(k=>[k,resolve(r[k])]));
 }
 return resolve;
}
function document(v:unknown){
 if(typeof v==='string'){check(Buffer.byteLength(v)<=131072);v=JSON.parse(v.trim().startsWith('{')?v:decodeURIComponent(v));}
 const d=obj(v);check(Buffer.byteLength(JSON.stringify(d))<=131072&&d.Version==='2012-10-17'&&Array.isArray(d.Statement));return d;
}
function set(values:unknown){check(Array.isArray(values));const rows=values.map(deploymentCanonical);check(new Set(rows).size===rows.length);return [...rows].sort();}
function policy(v:unknown,allowId=false){
 const d=document(v);check(Object.keys(d).every(k=>['Version','Statement',...(allowId?['Id']:[])].includes(k)));
 if('Id' in d)check(allowId&&d.Id==='default');
 const statements=(d.Statement as unknown[]).map(raw=>{
  const s={...obj(raw)};if(s.Sid==='')delete s.Sid;
  for(const key of ['Action','Resource'])if(key in s){const a=typeof s[key]==='string'?[s[key]]:s[key];s[key]=set(a);}
  return s;
 });return {Version:d.Version,Statement:set(statements)};
}
/** Expected configuration, not observed evidence. Exported for drift tests. */
export function expectedFullscriptInstalledControls(plan:DeploymentPlan,o:DeploymentObservation){
 const resources=obj(obj(JSON.parse(plan.templateBody)).Resources),roleProps=obj(obj(resources.Role).Properties),resolve=resolver(plan);
 const roleName=physical(o,'Role'),versionArn=physical(o,'Version');
 check(/^[A-Za-z0-9_+=,.@-]{1,64}$/.test(roleName)&&new RegExp('^'+plan.target.target.functionArn+':[1-9][0-9]*$').test(versionArn));
 const policies=roleProps.Policies;check(Array.isArray(policies)&&policies.length===1);const inline=obj(policies[0]);
 const values=Object.fromEntries(plan.parameters.map(p=>[p.ParameterKey,p.ParameterValue]));
 const statements=['Consumer','Workforce'].map(kind=>({Effect:'Allow',Principal:{Service:'apigateway.amazonaws.com'},Action:'lambda:InvokeFunction',Resource:versionArn,
  Condition:{StringEquals:{'AWS:SourceAccount':'588966314750'},ArnLike:{'AWS:SourceArn':`arn:aws:execute-api:us-east-2:588966314750:${values.ApiId}/*/POST/clinical-core/${kind.toLowerCase()}/fullscript/draft`}}}));
 return {roleName,roleArn:'arn:aws:iam::588966314750:role/'+roleName,trust:resolve(roleProps.AssumeRolePolicyDocument),
  policyName:inline.PolicyName,inline:resolve(inline.PolicyDocument),versionArn,invoke:{Version:'2012-10-17',Statement:statements},
  logGroupName:resolve(obj(obj(resources.Logs).Properties).LogGroupName),logRetention:obj(obj(resources.Logs).Properties).RetentionInDays,
  concurrency:obj(obj(resources.Function).Properties).ReservedConcurrentExecutions,
  alarms:['Errors','Throttles'].map(metric=>({name:physical(o,metric+'Alarm'),properties:resolve(obj(obj(resources[metric+'Alarm']).Properties))}))};
}
export function verifyFullscriptInstalledControls(plan:DeploymentPlan,o:DeploymentObservation){
 try{
  const c=o.controls;check(c);const e=expectedFullscriptInstalledControls(plan,o),role=obj(c.role.Role);
  check(role.RoleName===e.roleName&&role.Arn===e.roleArn&&role.Path==='/'&&role.PermissionsBoundary===undefined&&same(policy(role.AssumeRolePolicyDocument),policy(e.trust)));
  check(c.policyNames.IsTruncated===false&&c.policyNames.Marker===undefined&&same(c.policyNames.PolicyNames,[e.policyName]));
  check(c.attached.IsTruncated===false&&c.attached.Marker===undefined&&same(c.attached.AttachedPolicies,[]));
  check(c.inline.RoleName===e.roleName&&c.inline.PolicyName===e.policyName&&same(policy(c.inline.PolicyDocument),policy(e.inline)));
  const invoke=document(c.lambdaPolicy.Policy);check(typeof c.lambdaPolicy.RevisionId==='string'&&c.lambdaPolicy.RevisionId.length>0);
  const statements=invoke.Statement as unknown[],sids=statements.map(r=>obj(r).Sid);check(sids.length===2&&sids.every(s=>typeof s==='string'&&s.length>0)&&new Set(sids).size===2);
  const stripped={...invoke,Statement:statements.map(raw=>{const s={...obj(raw)};delete s.Sid;return s;})};
  check(same(policy(stripped,true),policy(e.invoke))&&same(c.concurrency,{ReservedConcurrentExecutions:e.concurrency}));
  check(c.logs.nextToken===undefined&&c.logs.NextToken===undefined&&Array.isArray(c.logs.logGroups));
  const logs=(c.logs.logGroups as Obj[]).filter(r=>r.logGroupName===e.logGroupName);check(logs.length===1&&logs[0].retentionInDays===e.logRetention);
  check(c.alarms.NextToken===undefined&&Array.isArray(c.alarms.MetricAlarms)&&(c.alarms.CompositeAlarms===undefined||same(c.alarms.CompositeAlarms,[])));
  const alarms=c.alarms.MetricAlarms as Obj[];check(alarms.length===e.alarms.length);
  for(const expected of e.alarms){
   const found=alarms.filter(r=>r.AlarmName===expected.name);check(found.length===1);const a=found[0],p=obj(expected.properties);
   check(a.AlarmArn===`arn:aws:cloudwatch:us-east-2:588966314750:alarm:${expected.name}`&&a.ActionsEnabled===true
    &&(a.OKActions===undefined||same(a.OKActions,[]))&&(a.InsufficientDataActions===undefined||same(a.InsufficientDataActions,[]))
    &&a.Metrics===undefined&&a.ExtendedStatistic===undefined&&a.Unit===undefined&&a.ThresholdMetricId===undefined
    &&(a.DatapointsToAlarm===undefined||a.DatapointsToAlarm===p.EvaluationPeriods)&&a.EvaluateLowSampleCountPercentile===undefined);
   for(const key of ['AlarmDescription','Namespace','MetricName','Dimensions','Statistic','Period','EvaluationPeriods','Threshold','ComparisonOperator','TreatMissingData','AlarmActions'])check(same(a[key],p[key]));
  }
  return {installedControlsObserved:true as const,iamQualified:false as const,alarmDeliveryProven:false as const};
 }catch{return fail();}
}
/** Read-only collector. A denied or partial inventory is not a matched control. */
export async function observeFullscriptInstalledControls(plan:DeploymentPlan,o:DeploymentObservation,read:(service:string,action:string,input:Obj)=>Promise<Obj>):Promise<FullscriptInstalledControls>{
 try{
  const e=expectedFullscriptInstalledControls(plan,o);
  return {role:await read('iam','get-role',{RoleName:e.roleName}),policyNames:await read('iam','list-role-policies',{RoleName:e.roleName}),
   attached:await read('iam','list-attached-role-policies',{RoleName:e.roleName}),inline:await read('iam','get-role-policy',{RoleName:e.roleName,PolicyName:e.policyName}),
   lambdaPolicy:await read('lambda','get-policy',{FunctionName:e.versionArn}),concurrency:await read('lambda','get-function-concurrency',{FunctionName:plan.target.target.functionArn}),
   logs:await read('logs','describe-log-groups',{logGroupNamePrefix:e.logGroupName}),
   alarms:await read('cloudwatch','describe-alarms',{AlarmNames:e.alarms.map(a=>a.name),AlarmTypes:['MetricAlarm']})};
 }catch{return fail();}
}
