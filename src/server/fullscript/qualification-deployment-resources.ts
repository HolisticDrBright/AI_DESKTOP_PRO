if(typeof window!=='undefined')throw Error('Fullscript deployment resources are server-only.');
import {deploymentCanonical,deploymentDigest,type DeploymentPlan} from './qualification-deployment-execution';
type Obj=Record<string,unknown>;
export type FullscriptResourcePort={now():number;identity():Promise<Obj>;
 metadata(service:string,action:string,input:Obj):Promise<Obj>;
 object(key:string,version:string,maximum:number):Promise<{bytes:Buffer;metadata:Obj}>;
 database(target:Obj):Promise<Obj>};
const fail=():never=>{throw Error('fullscript_deployment_resources_refused');};
const check=(v:unknown)=>{if(!v)fail();};
const object=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))return fail();return v as Obj;};
const same=(a:unknown,b:unknown)=>deploymentCanonical(a)===deploymentCanonical(b);
const list=(v:unknown):unknown[]=>{if(!Array.isArray(v))return fail();return v;};
const sameRows=(a:unknown,b:unknown)=>same(list(a).map(deploymentCanonical).sort(),list(b).map(deploymentCanonical).sort());
function principal(v:Obj){check(v.Account==='588966314750'&&typeof v.Arn==='string'
 &&/^arn:aws:sts::588966314750:assumed-role\/[A-Za-z0-9_+=,.@/-]+$/.test(v.Arn));}
function roles(v:unknown,login:string){
 const rows=list(v);check(rows.length>=1&&rows.length<=2&&new Set(rows.map(r=>object(r).name)).size===rows.length);
 for(const raw of rows){const r=object(raw);check((r.name===login||r.name==='fullscript_draft_worker')
  &&r.superuser===false&&r.createRole===false&&r.createDatabase===false&&r.replication===false&&r.bypassRls===false);}
 check(rows.some(r=>object(r).name===login));
}
/** Requires real read observations. Review hashes alone cannot substitute for
 * an object version, current identity, worker session or resource metadata.
 * It establishes prerequisites, NOT deployed IAM/provider/PHI qualification. */
export async function observeFullscriptDeploymentResources(plan:DeploymentPlan,port:FullscriptResourcePort){
 try{
  plan=structuredClone(plan);const started=port.now(),identity=structuredClone(await port.identity());principal(identity);
  check(Number.isFinite(started));
  const timely=()=>check(Number.isFinite(port.now())&&port.now()>=started&&port.now()-started<=120000);
  const values=Object.fromEntries(plan.parameters.map(r=>[r.ParameterKey,r.ParameterValue]));
  const target=object(plan.target.target),credentials=object(plan.target.credentials);
  const observations:unknown[]=[];
  const read=async(service:string,action:string,input:Obj)=>{
   timely();const r=structuredClone(await port.metadata(service,action,structuredClone(input)));timely();
   check(r.NextToken===undefined&&r.NextMarker===undefined);observations.push({service,action,input,result:r});return r;
  };
  const api=await read('apigatewayv2','get-api',{ApiId:target.apiId});
  check(api.ApiId===target.apiId&&api.ProtocolType==='HTTP'&&api.ApiEndpoint===`https://${target.apiId}.execute-api.us-east-2.amazonaws.com`
   &&api.DisableExecuteApiEndpoint!==true);
  const routes=await read('apigatewayv2','get-routes',{ApiId:target.apiId});list(routes.Items);
  // Route absence is checked again by the execution observer immediately
  // before CREATE/execute. A deployed recovery is allowed to have its routes.
  const clusters=list((await read('rds','describe-db-clusters',{DBClusterIdentifier:target.clusterArn})).DBClusters);check(clusters.length===1);
  const cluster=object(clusters[0]);
  check(cluster.DBClusterArn===target.clusterArn&&cluster.Engine==='aurora-postgresql'&&cluster.Status==='available'
   &&cluster.HttpEndpointEnabled===true&&cluster.StorageEncrypted===true);
  for(const kind of ['Database','Provider']){
   const arn=values[kind+'SecretArn'],key=values[kind+'SecretKmsKeyArn'];
   const secret=await read('secretsmanager','describe-secret',{SecretId:arn});
   check(secret.ARN===arn&&secret.DeletedDate===undefined&&(secret.PrimaryRegion===undefined||secret.PrimaryRegion==='us-east-2'));
   if(key){check(secret.KmsKeyId===key);const k=object((await read('kms','describe-key',{KeyId:key})).KeyMetadata);
    check(k.Arn===key&&k.KeyState==='Enabled'&&k.KeyUsage==='ENCRYPT_DECRYPT'&&k.KeyManager==='CUSTOMER');
   }else check(secret.KmsKeyId===undefined||secret.KmsKeyId==='alias/aws/secretsmanager');
   const versions=object(secret.VersionIdsToStages);
   if(kind==='Provider')check(Object.hasOwn(versions,String(credentials.providerSecretVersion))&&Array.isArray(versions[String(credentials.providerSecretVersion)]));
   else check(Object.values(versions).filter(v=>list(v).includes('AWSCURRENT')).length===1);
  }
  const table=object((await read('dynamodb','describe-table',{TableName:credentials.tokenTable})).Table);
  check(table.TableName===credentials.tokenTable&&table.TableArn===`arn:aws:dynamodb:us-east-2:588966314750:table/${credentials.tokenTable}`&&table.TableStatus==='ACTIVE'
   &&sameRows(table.KeySchema,[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}])
   &&sameRows(table.AttributeDefinitions,[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}]));
  // Absence means DynamoDB's default AWS-owned encryption, not no encryption.
  if(table.SSEDescription!==undefined){const s=object(table.SSEDescription);check(s.Status==='ENABLED'&&s.SSEType==='KMS');}
  const people=new Set<string>(),subjects=new Set<string>();
  for(const kind of ['consumer','workforce']){
   const poolId=String(target[kind+'Issuer']).split('/').at(-1)!;
   const pool=object((await read('cognito-idp','describe-user-pool',{UserPoolId:poolId})).UserPool);
   check(pool.Id===poolId&&pool.Arn===`arn:aws:cognito-idp:us-east-2:588966314750:userpool/${poolId}`
    &&(pool.Status===undefined||pool.Status==='Enabled'));
   const clientId=target[kind+'Audience'];
   const client=object((await read('cognito-idp','describe-user-pool-client',{UserPoolId:poolId,ClientId:clientId})).UserPoolClient);
   check(client.UserPoolId===poolId&&client.ClientId===clientId&&same(client.SupportedIdentityProviders,['COGNITO']));
   if(kind==='workforce'){
    const flows=list(client.ExplicitAuthFlows);
    check(pool.MfaConfiguration==='ON'&&pool.DeviceConfiguration===undefined&&flows.length>0&&new Set(flows).size===flows.length
     &&flows.some(f=>['ALLOW_USER_PASSWORD_AUTH','ALLOW_USER_SRP_AUTH','ALLOW_ADMIN_USER_PASSWORD_AUTH'].includes(String(f)))
     &&flows.every(f=>['ALLOW_USER_PASSWORD_AUTH','ALLOW_USER_SRP_AUTH','ALLOW_ADMIN_USER_PASSWORD_AUTH','ALLOW_REFRESH_TOKEN_AUTH'].includes(String(f))));
   }
   for(const subject of list(target[kind+'Subjects'])){
    check(typeof subject==='string'&&!subjects.has(String(subject)));subjects.add(String(subject));
    const user=await read('cognito-idp','admin-get-user',{UserPoolId:poolId,Username:subject});
    check(user.Enabled===true&&user.UserStatus==='CONFIRMED');const attributes=new Map<string,string>();
    for(const raw of list(user.UserAttributes)){const a=object(raw);check(typeof a.Name==='string'&&typeof a.Value==='string'&&!attributes.has(a.Name));attributes.set(String(a.Name),String(a.Value));}
    check(attributes.get('sub')===subject&&attributes.get('custom:organization_id')===target.organizationId
     &&attributes.get('email_verified')==='true'&&attributes.get('custom:production_bound')==='true'
     &&attributes.get('custom:synthetic_attested')!=='true'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attributes.get('custom:person_id')??'')&&!attributes.has('identities'));
    const person=attributes.get('custom:person_id')!;check(!people.has(person));people.add(person);
    if(kind==='workforce')check(list(user.UserMFASettingList).includes('SOFTWARE_TOKEN_MFA')&&user.PreferredMfaSetting==='SOFTWARE_TOKEN_MFA');
   }
  }
  const topic=object((await read('sns','get-topic-attributes',{TopicArn:values.AlarmTopicArn})).Attributes);
  check(topic.TopicArn===values.AlarmTopicArn&&topic.Owner==='588966314750'); // not delivery acceptance
  for(const [key,version,sha,maximum,type] of [
   [values.CodeKey,values.CodeObjectVersion,plan.zipSha256,16*1024*1024,'application/zip'],
   [values.TargetKey,values.TargetObjectVersion,plan.targetSha256,65536,'application/json'],
  ] as const){
   timely();const observed=await port.object(key,version,maximum),m=structuredClone(observed.metadata);timely();
   check(Buffer.isBuffer(observed.bytes)&&observed.bytes.length>0&&observed.bytes.length<=maximum&&deploymentDigest(observed.bytes)===sha
    &&m.VersionId===version&&m.ContentLength===observed.bytes.length&&m.ServerSideEncryption==='AES256'
    &&m.ContentType===type&&m.ContentEncoding===undefined&&m.ContentRange===undefined&&m.DeleteMarker!==true);
   observations.push({key,version,sha256:deploymentDigest(observed.bytes),metadata:m});
  }
  timely();const sql=structuredClone(await port.database(structuredClone(target)));timely();
  check(sql.databaseName===target.databaseName&&sql.workerRole==='fullscript_draft_worker'&&sql.readOnly===true&&sql.rollbackConfirmed===true
   &&typeof sql.loginName==='string'&&/^alp_fullscript_qualification_[a-z0-9_]{1,30}$/.test(sql.loginName));
  roles(sql.reachableRoles,String(sql.loginName));roles(sql.workerRoles,'fullscript_draft_worker');
  check(list(sql.loginSchemaCreate).length===0&&list(sql.workerSchemaCreate).length===0);
  const allowed=['fullscript_delivery.draft_intents:INSERT','fullscript_delivery.draft_intents:SELECT','fullscript_delivery.draft_intents:UPDATE'];
  check(same(list(sql.workerTablePrivileges).slice().sort(),allowed)&&list(sql.loginTablePrivileges).every(v=>allowed.includes(String(v)))
   &&new Set(list(sql.loginTablePrivileges)).size===list(sql.loginTablePrivileges).length&&same(sql.ledger,target.migrations));
  observations.push({database:sql});const after=await port.identity();principal(after);
  check(same(after,identity));timely();
  return {contract:'fullscript-deployment-prerequisites/1',sourceCommit:plan.sourceCommit,reviewSha256:plan.reviewSha256,
   observedAt:new Date(port.now()).toISOString(),observationSha256:deploymentDigest(Buffer.from(deploymentCanonical(observations))),
   resourcePrerequisitesObserved:true,deployed:false,providerCredentialRead:false,providerActionPerformed:false,
   alarmDeliveryProven:false,hostedQualified:false,phiAllowed:false,activation:'blocked'};
 }catch{return fail();}
}
