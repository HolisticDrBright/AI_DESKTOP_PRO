// Test fixture only. No caller imports this into the native command or API.
import {expectedFullscriptInstalledControls,type FullscriptInstalledControls} from './qualification-deployment-controls';
import type {DeploymentPlan,DeploymentObservation} from './qualification-deployment-execution';
export function fictionalInstalledControls(plan:DeploymentPlan,o:DeploymentObservation):FullscriptInstalledControls{
 const e=expectedFullscriptInstalledControls(plan,o);
 const policy=structuredClone(e.invoke) as {Statement:Record<string,unknown>[]};policy.Statement.forEach((s,i)=>{s.Sid='fictional-'+i;});
 return {role:{Role:{RoleName:e.roleName,Arn:e.roleArn,Path:'/',AssumeRolePolicyDocument:e.trust}},
  inline:{RoleName:e.roleName,PolicyName:e.policyName,PolicyDocument:e.inline},policyNames:{IsTruncated:false,PolicyNames:[e.policyName]},
  attached:{IsTruncated:false,AttachedPolicies:[]},lambdaPolicy:{RevisionId:'fictional-revision',Policy:JSON.stringify(policy)},
  concurrency:{ReservedConcurrentExecutions:e.concurrency},logs:{logGroups:[{logGroupName:e.logGroupName,retentionInDays:e.logRetention}]},
  alarms:{MetricAlarms:e.alarms.map(a=>({...a.properties as Record<string,unknown>,AlarmName:a.name,
   AlarmArn:'arn:aws:cloudwatch:us-east-2:588966314750:alarm:'+a.name,ActionsEnabled:true,OKActions:[],InsufficientDataActions:[]}))}};
}
