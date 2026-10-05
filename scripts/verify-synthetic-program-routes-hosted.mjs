/** Hosted smoke test of the two synthetic-only program routes with designated fictional identities. */
import {readFileSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHmac,randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {CognitoIdentityProviderClient,AdminInitiateAuthCommand,AdminRespondToAuthChallengeCommand} from '@aws-sdk/client-cognito-identity-provider';
import {RDSDataClient,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {fromIni} from '@aws-sdk/credential-provider-ini';

const root=process.argv[4];
const account='588966314750',region='us-east-2',profile='ai-synthetic-staging';
const api='https://wxv734oi12.execute-api.us-east-2.amazonaws.com';
const assert=(ok,code)=>{if(!ok)throw Error(code);};
function totp(secret){
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes=[];
 for(const letter of secret.toUpperCase().replace(/=+$/,'')){const digit=alphabet.indexOf(letter);assert(digit>=0,'mfa_secret_invalid');value=(value<<5)|digit;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>bits)&255);}}
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const hash=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();const offset=hash.at(-1)&15;
 return (hash.readUInt32BE(offset)&0x7fffffff)%1000000+'';
}
async function main(){
 assert(process.argv.length===5&&process.argv[2]==='--confirm-fictional-only'&&process.argv[3]==='--identity-dir'&&isAbsolute(root),'command_refused');
 const identity=JSON.parse(execFileSync('aws',['sts','get-caller-identity','--profile',profile,'--region',region,'--output','json'],{encoding:'utf8',windowsHide:true}));
 assert(identity.Account===account,'account_refused');
 const sealed=readFileSync(root+'/credentials.dpapi.txt','utf8');
 const decrypt='$s=ConvertTo-SecureString ([Console]::In.ReadToEnd());$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';
 const opened=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',decrypt],{input:sealed,encoding:'utf8',windowsHide:true,timeout:20000});
 assert(opened.status===0,'credential_decryption_failed');
 const state=JSON.parse(opened.stdout);assert(state.account===account&&state.containsPhi===false&&state.schemaVersion==='messaging-identity-state/1','fixture_refused');
 const client=new CognitoIdentityProviderClient({region,credentials:fromIni({profile})});
 const tokens={};
 for(const role of ['consumer','foreignConsumer','workforce']){
  const user=state.users[role];assert(user?.username.endsWith('@example.invalid')&&user.password&&user.pool&&user.clientId,'fictional_identity_refused');
  let auth=await client.send(new AdminInitiateAuthCommand({UserPoolId:user.pool,ClientId:user.clientId,AuthFlow:'ADMIN_USER_PASSWORD_AUTH',AuthParameters:{USERNAME:user.username,PASSWORD:user.password}}));
  if(auth.ChallengeName==='SOFTWARE_TOKEN_MFA'&&role==='workforce')auth=await client.send(new AdminRespondToAuthChallengeCommand({UserPoolId:user.pool,ClientId:user.clientId,ChallengeName:'SOFTWARE_TOKEN_MFA',Session:auth.Session,ChallengeResponses:{USERNAME:user.username,SOFTWARE_TOKEN_MFA_CODE:totp(user.totpSecret).padStart(6,'0')}}));
  assert(auth.AuthenticationResult?.IdToken,'authentication_failed');tokens[role]=auth.AuthenticationResult.IdToken;
  const claims=JSON.parse(Buffer.from(tokens[role].split('.')[1],'base64url').toString());
  assert(claims.aud===user.clientId,'token_audience_refused');
  assert(claims['custom:person_id']===user.personId,'token_person_refused');
  assert(claims['custom:organization_id']===state.organizationId,'token_organization_refused');
  assert(claims['custom:synthetic_attested']==='true','token_synthetic_attestation_refused');
  assert(claims.token_use==='id','token_kind_refused');
 }
 async function request(role,path,body,expected){
  const result=await fetch(api+path,{method:'POST',headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  const raw=await result.text();assert(raw.length<250000,'response_oversize');let parsed;try{parsed=JSON.parse(raw);}catch{throw Error('response_not_json');}
  if(result.status!==expected){const category=typeof parsed.error==='string'&&/^[a-z_]+$/.test(parsed.error)?parsed.error:'unknown';throw Error('unexpected_status_'+role+'_'+result.status+'_'+category);}
  return parsed;
 }
 const list=await request('consumer','/clinical-core/consumer/programs',{action:'list'},200);
 assert(list.data?.action==='list'&&Array.isArray(list.data.assignments),'consumer_list_invalid');
 const other=await request('foreignConsumer','/clinical-core/consumer/programs',{action:'list'},200);
 assert(other.data?.action==='list'&&Array.isArray(other.data.assignments),'foreign_list_invalid');
 const programs=await request('workforce','/clinical-core/workforce/programs',{action:'programs'},200);
 assert(programs.data?.action==='programs'&&Array.isArray(programs.data.programs),'workforce_programs_invalid');
 const wrongRole=await request('consumer','/clinical-core/consumer/programs',{action:'programs'},403);
 assert(wrongRole.error==='identity_refused','consumer_role_boundary_failed');
 const otherWrong=await request('workforce','/clinical-core/workforce/programs',{action:'list'},403);
 assert(otherWrong.error==='identity_refused','workforce_role_boundary_failed');
 const noAuth=await fetch(api+'/clinical-core/consumer/programs',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"list"}',redirect:'error'});
 assert(noAuth.status===401||noAuth.status===403,'jwt_boundary_failed');
 // A real hosted assignment journey, but with only fictional content and an
 // intentionally unresolved product. It may not become an approved catalog item.
 const stack=JSON.parse(execFileSync('aws',['cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging','--profile',profile,'--region',region,'--output','json'],{encoding:'utf8',windowsHide:true})).Stacks[0];
 const outputs=Object.fromEntries(stack.Outputs.map(x=>[x.OutputKey,x.OutputValue]));
 assert(outputs.PhiAllowed==='false'&&outputs.DataClassification==='synthetic_only'&&outputs.DatabaseName==='clinical_core','clinical_target_refused');
 const rds=new RDSDataClient({region,credentials:fromIni({profile})});
 async function sql(statement,values=[]){
  const result=await rds.send(new ExecuteStatementCommand({resourceArn:outputs.DatabaseClusterArn,secretArn:outputs.DatabaseSecretArn,database:'clinical_core',sql:statement,
   parameters:values.map((v,i)=>({name:'p'+i,value:{stringValue:String(v)}})),formatRecordsAs:'JSON'}));
  return JSON.parse(result.formattedRecords??'[]');
 }
 const fixture=JSON.parse(readFileSync(root+'/messaging-fixture.json','utf8'));
 assert(fixture.organizationId===state.organizationId,'connection_fixture_refused');
 const ledger=await sql('select count(*)::int as count,max(version) as latest from clinical_core.schema_migrations');
 assert(ledger[0]?.count===35&&ledger[0]?.latest==='20260929120000','program_migration_refused');
 const link=await sql("select organization_id,consumer_person_id,state from clinical_core.patient_connections where id=:p0::uuid",[fixture.connectionId]);
 assert(link[0]?.organization_id===state.organizationId&&link[0]?.consumer_person_id===state.users.consumer.personId&&link[0]?.state==='verified','connection_fixture_refused');
 const membership=await sql("select role from clinical_core.organization_memberships where organization_id=:p0::uuid and person_id=:p1::uuid",[state.organizationId,state.users.workforce.personId]);
 assert(membership[0]?.role==='practitioner','workforce_membership_refused');
 let programId=randomUUID(),versionId=randomUUID();
 const phases=[{id:'phase-1',title:'Fictional phase',days:1,transition:'scheduled',items:[
  {id:'lesson-a',title:'Fictional lesson',kind:'lesson',instructions:'Read the fictional lesson.',released:true},
  {id:'supp-1',title:'Fictional unresolved product',kind:'supplement',instructions:'Fictional test only.',released:true,
   product:{id:'product-fictional-1',ingredientKeys:['fictional-mineral'],dose:'100 mg',purchaseUrl:null}},
 ]}];
 const content={consumerProgram:{title:'Fictional hosted guide',phases}};
 const previous=await sql("select p.id as program_id,v.id as version_id,v.content,v.status from clinical_core.synthetic_desktop_programs p join clinical_core.synthetic_desktop_program_versions v on v.program_id=p.id where p.organization_id=:p0::uuid and p.name='Fictional hosted program acceptance' and p.created_by_person_id=:p1::uuid",[state.organizationId,state.users.workforce.personId]);
 assert(previous.length<=1,'ambiguous_test_program');
 if(previous.length){
  const stored=typeof previous[0].content==='string'?JSON.parse(previous[0].content):previous[0].content;
  assert(previous[0].status==='published'&&isDeepStrictEqual(stored,content),'test_program_changed');
  programId=previous[0].program_id;versionId=previous[0].version_id;
 }else{
  await sql("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values(:p0::uuid,:p1::uuid,'Fictional hosted program acceptance','published',:p2::uuid)",[programId,state.organizationId,state.users.workforce.personId]);
  await sql("insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id) values(:p0::uuid,:p1::uuid,:p2::uuid,1,'published',:p3::jsonb,:p4::uuid)",
   [versionId,state.organizationId,programId,JSON.stringify(content),state.users.workforce.personId]);
 }
 const published=await request('workforce','/clinical-core/workforce/programs',{action:'programs'},200);
 assert(published.data.programs.some(p=>p.programVersionId===versionId),'published_version_not_visible');
 const assignment=await request('workforce','/clinical-core/workforce/programs',{action:'assign',connectionId:fixture.connectionId,programVersionId:versionId},200);
 assert(assignment.data?.action==='assign'&&(assignment.data.duplicate?assignment.data.state==='active':assignment.data.state==='offered'),'assignment_failed');
 const offered=await request('consumer','/clinical-core/consumer/programs',{action:'read',enrollmentId:assignment.data.enrollmentId},200);
 assert(offered.data?.review?.inventoryComplete===false&&offered.data.review.held.includes('supp-1')&&offered.data.review.add.includes('lesson-a'),'supplement_hold_failed');
 const foreignRead=await request('foreignConsumer','/clinical-core/consumer/programs',{action:'read',enrollmentId:assignment.data.enrollmentId},403);
 assert(foreignRead.error==='identity_refused','cross_owner_refusal_failed');
 let revision=offered.data.assignment.revision;
 if(!assignment.data.duplicate){
  const accepted=await request('consumer','/clinical-core/consumer/programs',{action:'accept',enrollmentId:assignment.data.enrollmentId,
   sourceDigest:assignment.data.sourceDigest,expectedRevision:revision,planRevision:offered.data.review.planRevision},200);
  assert(accepted.data?.state==='active','acceptance_failed');revision=accepted.data.revision;
 }else assert(offered.data.assignment.state==='active','replayed_assignment_not_active');
 const held=await request('consumer','/clinical-core/consumer/programs',{action:'complete',enrollmentId:assignment.data.enrollmentId,
  sourceDigest:assignment.data.sourceDigest,expectedRevision:revision,itemId:'supp-1'},403);
 assert(held.error==='identity_refused','held_product_completed');
 console.log(JSON.stringify({verdict:'pass',account,phiAllowed:false,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  observed:{consumerAssignments:list.data.assignments.length,foreignAssignments:other.data.assignments.length,publishedPrograms:programs.data.programs.length,
   consumerRoleRefused:true,workforceRoleRefused:true,unauthenticatedRefused:true,fictionalAssignmentAccepted:true,foreignOwnerRefused:true,unresolvedSupplementHeld:true},
  evidenceScope:'hosted fictional program assignment; no governed catalog release, device test or PHI approval'}));
}
main().catch(error=>{console.error(JSON.stringify({verdict:'blocked',error:/^[a-z0-9_]+$/.test(error.message)?error.message:'hosted_verification_failed'}));process.exitCode=1;});
