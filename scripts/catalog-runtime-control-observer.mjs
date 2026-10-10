/** Complete, bounded parallel read-only inventory. No cached/saved observations,
 * mutation commands, caller-selected target or retry port. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {refuseRegistered} from './synthetic-care-registered-release.mjs';
import {assertSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {canonical} from './care-recovery-routing.mjs';
const execute=promisify(execFile);
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_control_'+code);};
const all=async tasks=>{const settled=await Promise.allSettled(tasks),bad=settled.find(r=>r.status==='rejected');
 if(bad)throw bad.reason;return settled.map(r=>r.value);};
export async function catalogRuntimeReadInventory(call,args,itemsKey,tokenKey){
 const items=[],seen=new Set();let token;
 for(let page=0;page<10;page++){
  const answer=await call([...args,'--no-paginate',...(token?['--next-token',token]:[])]);
  check(Array.isArray(answer?.[itemsKey])&&answer[itemsKey].length<=300,'inventory_page');items.push(...answer[itemsKey]);
  check(items.length<=2000,'inventory_bound');token=answer[tokenKey];
  if(token===undefined||token===null)return {[itemsKey]:items};
  check(typeof token==='string'&&token.length>0&&token.length<=2048&&!seen.has(token),'inventory_token');seen.add(token);
 }
 refuseRegistered('catalog_runtime_control_inventory_pages');
}
/** Fictional test seam. The public observer supplies its own fixed CLI below. */
export async function readCatalogRuntimeControl(call){
 const identity=structuredClone(await call(['sts','get-caller-identity']));assertSyntheticMemberIdentity(identity);
 const resources=await call(['cloudformation','describe-stack-resources','--stack-name',P.stack,'--no-paginate']);
 const roleName=resources.StackResources?.find(r=>r.LogicalResourceId==='IdentityApiRole')?.PhysicalResourceId;
 check(typeof roleName==='string'&&/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName),'role_name');
 const policies=async()=>{const inline=await call(['iam','list-role-policies','--role-name',roleName,'--no-paginate']);
  check(Array.isArray(inline.PolicyNames)&&inline.PolicyNames.length<=10&&inline.IsTruncated===false
   &&inline.PolicyNames.every(n=>typeof n==='string'&&/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(n))
   &&new Set(inline.PolicyNames).size===inline.PolicyNames.length,'inline_inventory');
  return {inline,policies:await all(inline.PolicyNames.map(name=>call(['iam','get-role-policy','--role-name',roleName,'--policy-name',name])))};};
 const values=await all([
  call(['cloudformation','describe-stacks','--stack-name',P.foundation]),call(['cloudformation','describe-stacks','--stack-name',P.stack]),
  call(['cloudformation','get-template','--stack-name',P.stack,'--template-stage','Original']),
  call(['lambda','get-function-configuration','--function-name',P.functionName]),
  call(['iam','get-role','--role-name',roleName]),call(['iam','list-attached-role-policies','--role-name',roleName,'--no-paginate']),policies(),
  catalogRuntimeReadInventory(call,['logs','describe-log-groups','--log-group-name-prefix','/ai-clinical-core/synthetic-staging/identity-api','--limit','50'],'logGroups','nextToken'),
  catalogRuntimeReadInventory(call,['apigatewayv2','get-integrations','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
  catalogRuntimeReadInventory(call,['apigatewayv2','get-routes','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
  catalogRuntimeReadInventory(call,['apigatewayv2','get-authorizers','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
  call(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']),call(['lambda','get-policy','--function-name',P.functionName])]);
 const [foundation,stack,raw,fn,role,attached,policy,logGroups,integrations,routes,authorizers,stage,latestPolicy]=values;
 const next=await call(['sts','get-caller-identity']);assertSyntheticMemberIdentity(next);check(canonical(next)===canonical(identity),'principal_changed');
 return {foundation,stack,template:typeof raw.TemplateBody==='string'?JSON.parse(raw.TemplateBody):raw.TemplateBody,
  fn,resources,role,attached,...policy,logGroups,integrations,routes,authorizers,stage,latestPolicy};
}
export function catalogRuntimeReadQueue(call){
 let active=0;const waiters=[];
 return async args=>{
  if(active>=4)await new Promise(done=>waiters.push(done));else active++;
  try{return await call(args);}finally{if(waiters.length)waiters.shift()();else active--;}
 };
}
export async function observeCatalogRuntimeControlRaw(){
 const call=catalogRuntimeReadQueue(async args=>{
  try{
   check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
   const {stdout}=await execute('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
    {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true,
     env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});
   return stdout.trim()?JSON.parse(stdout):{};
  }catch{refuseRegistered('catalog_runtime_control_read_unconfirmed');}
 });
 return readCatalogRuntimeControl(call);
}
