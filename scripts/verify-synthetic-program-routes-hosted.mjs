/** Hosted smoke test of selected synthetic-only routes with designated fictional identities. */
import {readFileSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {CognitoIdentityProviderClient,AdminInitiateAuthCommand,AdminRespondToAuthChallengeCommand} from '@aws-sdk/client-cognito-identity-provider';
import {RDSDataClient,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {SYNTHETIC_MEMBER_PROFILE,observeSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';

const root=process.argv[4];
const account='588966314750',region='us-east-2',profile=SYNTHETIC_MEMBER_PROFILE;
const api='https://wxv734oi12.execute-api.us-east-2.amazonaws.com';
const deployedSourceCommit='b1f597d39fefde10d70a1e00d813967736df2e8f';
const deployedArtifactSha256='58f5978301be218896b269a44438fecb8ae89a690bee6671008b64f215f14247';
const approvedConsentTest=process.argv[5]==='--approved-fictional-intake-consent';
const consentCopy='I agree to store and use fictional test intake data in the ALP synthetic staging service for software testing. No real personal or health information may be entered.';
const consentVersion='fictional-intake-2026-10-05';
const consentDigest=createHash('sha256').update(consentCopy,'utf8').digest('hex');
const assert=(ok,code)=>{if(!ok)throw Error(code);};
let firstRequestObservation;
function totp(secret){
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes=[];
 for(const letter of secret.toUpperCase().replace(/=+$/,'')){const digit=alphabet.indexOf(letter);assert(digit>=0,'mfa_secret_invalid');value=(value<<5)|digit;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>bits)&255);}}
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const hash=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();const offset=hash.at(-1)&15;
 return (hash.readUInt32BE(offset)&0x7fffffff)%1000000+'';
}
async function main(){
 assert((process.argv.length===5||process.argv.length===6)&&process.argv[2]==='--confirm-fictional-only'&&process.argv[3]==='--identity-dir'&&isAbsolute(root)&&(!process.argv[5]||approvedConsentTest),'command_refused');
 const identity=observeSyntheticMemberIdentity();
 assert(identity.Account===account,'account_refused');
 const deployed=JSON.parse(execFileSync('aws',['cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging-authenticated-api','--profile',profile,'--region',region,'--output','json'],{encoding:'utf8',windowsHide:true})).Stacks[0];
 assert(deployed.StackStatus==='UPDATE_COMPLETE'&&deployed.Parameters.some(p=>p.ParameterKey==='LambdaCodeKey'&&p.ParameterValue===`clinical-core/authenticated-api/${deployedArtifactSha256}.zip`),'deployed_artifact_changed');
 const functionState=JSON.parse(execFileSync('aws',['lambda','get-function-configuration','--function-name','wxv734oi12-synthetic-identity','--profile',profile,'--region',region,'--output','json'],{encoding:'utf8',windowsHide:true}));
 assert(functionState.State==='Active'&&functionState.LastUpdateStatus==='Successful'&&functionState.CodeSha256===Buffer.from(deployedArtifactSha256,'hex').toString('base64'),'deployed_code_changed');
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
  const startedAt=new Date().toISOString(),started=performance.now();
  const result=await fetch(api+path,{method:'POST',headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  firstRequestObservation??={route:path,startedAt,status:result.status,durationMs:Math.round(performance.now()-started)};
  const raw=await result.text();assert(raw.length<250000,'response_oversize');let parsed;try{parsed=JSON.parse(raw);}catch{throw Error('response_not_json');}
  if(result.status!==expected){const category=typeof parsed.error==='string'&&/^[a-z_]+$/.test(parsed.error)?parsed.error:'unknown';throw Error('unexpected_status_'+role+'_'+path.replace(/[^a-z]/gi,'_')+'_'+result.status+'_'+category);}
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
 const erasures=await request('consumer','/clinical-core/consumer/care-data',{action:'erasure_history'},200);
 assert(erasures.data?.action==='erasure_history'&&Array.isArray(erasures.data.erasures),'owner_erasure_history_failed');
 const otherErasures=await request('foreignConsumer','/clinical-core/consumer/care-data',{action:'erasure_history'},200);
 assert(otherErasures.data?.action==='erasure_history'&&Array.isArray(otherErasures.data.erasures),'foreign_erasure_history_failed');
 const ownerCopy=await request('consumer','/clinical-core/consumer/care-data',{action:'export',section:'assignments',limit:10},200);
 assert(ownerCopy.data?.action==='export'&&ownerCopy.data.items.some(item=>item.enrollmentId),'owner_assignment_export_failed');
 const foreignCopy=await request('foreignConsumer','/clinical-core/consumer/care-data',{action:'export',section:'assignments',limit:10},200);
 assert(foreignCopy.data?.action==='export'&&foreignCopy.data.items.length===0,'foreign_assignment_export_leaked');
 const calendar=await request('workforce','/clinical-core/workforce/calendar-connection',{action:'read'},200);
 assert(calendar.data?.action==='read'&&typeof calendar.data.connected==='boolean','calendar_read_failed');
 const wrongCalendarRole=await request('consumer','/clinical-core/consumer/care-data',{action:'read'},400);
 assert(wrongCalendarRole.error==='request_invalid','care_data_vocabulary_boundary_failed');
 const noCalendarAuth=await fetch(api+'/clinical-core/workforce/calendar-connection',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"read"}',redirect:'error'});
 assert(noCalendarAuth.status===401||noCalendarAuth.status===403,'calendar_jwt_boundary_failed');
 const consultLinks=await request('workforce','/clinical-core/workforce/consult-links',{action:'list'},200);
 assert(consultLinks.data?.action==='list'&&Array.isArray(consultLinks.data.links),'consult_links_list_failed');
 const consultRequests=await request('workforce','/clinical-core/workforce/consult-requests',{action:'list'},200);
 assert(consultRequests.data?.action==='list'&&Array.isArray(consultRequests.data.requests),'consult_requests_list_failed');
 const intakeForms=await request('workforce','/clinical-core/workforce/intake-forms',{action:'list'},200);
 assert(intakeForms.data?.action==='list'&&Array.isArray(intakeForms.data.forms),'intake_forms_list_failed');
 const fictionalForm={sections:[{id:'fictional',title:'Fictional qualification',questions:[
  {id:'choice',prompt:'Which fictional test option is selected?',type:'single_choice',required:true,
   options:[{value:'one',label:'Option one'},{value:'two',label:'Option two'}]},
 ]}]};
 const priorDrafts=intakeForms.data.forms.filter(form=>form.formKey==='synthetic_qualification_route');
 assert(priorDrafts.length<=1,'fictional_form_ambiguous');
 let draftVersionId;
 if(priorDrafts.length){
  assert((priorDrafts[0].status==='draft'||approvedConsentTest&&priorDrafts[0].status==='published')&&priorDrafts[0].title==='Fictional route check','fictional_form_changed');
  draftVersionId=priorDrafts[0].formVersionId;
 }else{
  const drafted=await request('workforce','/clinical-core/workforce/intake-forms',{
   action:'draft',formKey:'synthetic_qualification_route',title:'Fictional route check',
   kind:'questionnaire',content:fictionalForm},200);
  assert(drafted.data?.action==='draft'&&drafted.data.status==='draft','fictional_draft_failed');
  draftVersionId=drafted.data.formVersionId;
 }
 const workforcePackets=await request('workforce','/clinical-core/workforce/intake-packets',{action:'list'},200);
 assert(workforcePackets.data?.action==='list'&&Array.isArray(workforcePackets.data.packets),'workforce_packets_list_failed');
 const consumerPackets=await request('consumer','/clinical-core/consumer/intake-packets',{action:'list'},200);
 assert(consumerPackets.data?.action==='list'&&Array.isArray(consumerPackets.data.packets),'consumer_packets_list_failed');
 const foreignPackets=await request('foreignConsumer','/clinical-core/consumer/intake-packets',{action:'list'},200);
 assert(foreignPackets.data?.action==='list'&&Array.isArray(foreignPackets.data.packets),'foreign_packets_list_failed');
 const wrongIntakeRole=await fetch(api+'/clinical-core/workforce/intake-forms',{method:'POST',headers:{authorization:'Bearer '+tokens.consumer,'content-type':'application/json'},body:'{"action":"list"}',redirect:'error'});
 assert(wrongIntakeRole.status===401||wrongIntakeRole.status===403,'intake_role_boundary_failed');
 const noIntakeAuth=await fetch(api+'/clinical-core/workforce/intake-forms',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"list"}',redirect:'error'});
 assert(noIntakeAuth.status===401||noIntakeAuth.status===403,'intake_jwt_boundary_failed');
 const withheldPublic=await fetch(api+'/clinical-core/public/consult-intake',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"describe","slug":"fictional-longevity"}',redirect:'error'});
 assert(withheldPublic.status===404,'public_consult_route_exposed');
 const finalReads=[
  ['workforce','/clinical-core/workforce/disputes',{action:'list'}],
  ['consumer','/clinical-core/consumer/disputes',{action:'list'}],
  ['workforce','/clinical-core/workforce/content-revisions',{action:'list'}],
  ['consumer','/clinical-core/consumer/content-revisions',{action:'list'}],
  ['workforce','/clinical-core/workforce/note-templates',{action:'list'}],
  ['workforce','/clinical-core/workforce/note-drafting-context',{action:'resolve',noteType:'soap'}],
  ['workforce','/clinical-core/workforce/outcome-ledger',{action:'vocabulary'}],
  ['workforce','/clinical-core/workforce/outcome-report',{action:'report',groupBy:[]}],
  ['workforce','/clinical-core/workforce/consult-retention',{action:'settings_read'}],
 ];
 for(const [role,path,body] of finalReads){
  const read=await request(role,path,body,200);
  assert(read.data?.action===body.action,'final_route_read_failed');
  const anonymous=await fetch(api+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error'});
  assert(anonymous.status===401||anonymous.status===403,'final_route_anonymous_allowed');
  const wrongRole=role==='consumer'?'workforce':'consumer';
  const denied=await fetch(api+path,{method:'POST',headers:{authorization:'Bearer '+tokens[wrongRole],'content-type':'application/json'},body:JSON.stringify(body),redirect:'error'});
  assert(denied.status===401||denied.status===403,'final_route_role_boundary_failed');
 }
 // A fictional practice template is safe to author only if this isolated test
 // organization has no other active SOAP template. Never overwrite a clinic choice.
 const templateName='Fictional hosted SOAP template';
 const templateSections=[{key:'S',label:'Subjective',guidance:'Fictional test observations only.'},
  {key:'P',label:'Plan',guidance:'Fictional test follow-up only.'}];
 const templateList=await request('workforce','/clinical-core/workforce/note-templates',{action:'list'},200);
 const activeSoap=templateList.data?.templates?.filter(t=>t.noteType==='soap'&&t.status==='active');
 assert(Array.isArray(activeSoap)&&activeSoap.length<=1&&(!activeSoap.length||activeSoap[0].name===templateName),
  'fictional_template_slot_not_isolated');
 let templateId=activeSoap[0]?.templateId;
 let templateRead=templateId?await request('workforce','/clinical-core/workforce/note-templates',
  {action:'read',templateId},200):null;
 if(!templateId){
  const saved=await request('workforce','/clinical-core/workforce/note-templates',{
   action:'save_draft',noteType:'soap',name:templateName,sections:templateSections},200);
  assert(saved.data?.status==='draft'&&saved.data.templateId,'fictional_template_draft_failed');
  templateId=saved.data.templateId;
  templateRead=await request('workforce','/clinical-core/workforce/note-templates',{action:'read',templateId},200);
 }
 const draft=templateRead.data?.versions?.find(v=>v.status==='draft');
 const currentTemplate=templateRead.data?.versions?.find(v=>v.status==='published');
 assert(templateRead.data?.name===templateName&&templateRead.data.noteType==='soap'
  &&(!currentTemplate||isDeepStrictEqual(currentTemplate.sections,templateSections))
  &&(!draft||isDeepStrictEqual(draft.sections,templateSections)),'fictional_template_content_changed');
 if(draft){
  const stale=await request('workforce','/clinical-core/workforce/note-templates',
   {action:'publish',templateId,contentSha256:'0'.repeat(64)},409);
  assert(stale.error==='digest_stale','fictional_template_stale_digest_allowed');
  const publishedTemplate=await request('workforce','/clinical-core/workforce/note-templates',
   {action:'publish',templateId,contentSha256:draft.contentSha256},200);
  assert(publishedTemplate.data?.status==='published'&&publishedTemplate.data.contentSha256===draft.contentSha256,
   'fictional_template_publish_failed');
 }
 const draftingContext=await request('workforce','/clinical-core/workforce/note-drafting-context',
  {action:'resolve',noteType:'soap'},200);
 assert(draftingContext.data?.template?.templateId===templateId,'fictional_drafting_template_id_mismatch');
 assert(isDeepStrictEqual(draftingContext.data.template.sections.map(({key,label,guidance})=>({key,label,guidance:guidance??null})),
  templateSections.map(({key,label,guidance})=>({key,label,guidance:guidance??null}))),
  'fictional_drafting_sections_mismatch');
 assert(draftingContext.data.context?.breadth==='none','fictional_drafting_breadth_mismatch');
 // `none` means no prior chart was requested or searched, not an available empty chart.
 assert(draftingContext.data.context.available===false
  &&draftingContext.data.context.withheldReason===null,'fictional_drafting_context_claimed_prior_chart');
 // Keep a second, unpublished fictional draft to prove the stale-digest
 // refusal on every replay. A failed publish must not create a live template.
 const probeName='Fictional stale-digest probe';
 const probeSections=[{key:'T',label:'Test',guidance:'Fictional test content only.'}];
 const narrative=templateList.data.templates.filter(t=>t.noteType==='narrative'&&t.status==='active');
 assert(narrative.length<=1&&(!narrative.length||narrative[0].name===probeName),
  'fictional_digest_probe_slot_not_isolated');
 let probeId=narrative[0]?.templateId;
 if(!probeId){
  const saved=await request('workforce','/clinical-core/workforce/note-templates',{
   action:'save_draft',noteType:'narrative',name:probeName,sections:probeSections},200);
  assert(saved.data?.status==='draft'&&saved.data.templateId,'fictional_digest_probe_draft_failed');
  probeId=saved.data.templateId;
 }
 const probeRead=await request('workforce','/clinical-core/workforce/note-templates',{action:'read',templateId:probeId},200);
 assert(probeRead.data?.name===probeName&&probeRead.data.versions.length===1
  &&probeRead.data.versions[0].status==='draft'
  &&isDeepStrictEqual(probeRead.data.versions[0].sections,probeSections),'fictional_digest_probe_changed');
 const staleProbe=await request('workforce','/clinical-core/workforce/note-templates',
  {action:'publish',templateId:probeId,contentSha256:'0'.repeat(64)},409);
 assert(staleProbe.error==='digest_stale','fictional_digest_probe_published_stale');
 // A real hosted assignment journey, but with only fictional content and an
 // intentionally unresolved product. It may not become an approved catalog item.
 const stack=JSON.parse(execFileSync('aws',['cloudformation','describe-stacks','--stack-name','ai-clinical-core-synthetic-staging','--profile',profile,'--region',region,'--output','json'],{encoding:'utf8',windowsHide:true})).Stacks[0];
 const outputs=Object.fromEntries(stack.Outputs.map(x=>[x.OutputKey,x.OutputValue]));
 assert(outputs.PhiAllowed==='false'&&outputs.DataClassification==='synthetic_only'&&outputs.DatabaseName==='clinical_core','clinical_target_refused');
 const rds=new RDSDataClient({region,credentials:fromIni({profile}),maxAttempts:1});
 async function sql(statement,values=[]){
  const result=await rds.send(new ExecuteStatementCommand({resourceArn:outputs.DatabaseClusterArn,secretArn:outputs.DatabaseSecretArn,database:'clinical_core',sql:statement,
   parameters:values.map((v,i)=>({name:'p'+i,value:{stringValue:String(v)}})),formatRecordsAs:'JSON'}));
  return JSON.parse(result.formattedRecords??'[]');
 }
 const fixture=JSON.parse(readFileSync(root+'/messaging-fixture.json','utf8'));
 assert(fixture.organizationId===state.organizationId,'connection_fixture_refused');
 const draftRows=await sql('select content::text as content from clinical_core.intake_form_versions where id=:p0::uuid and organization_id=:p1::uuid',[draftVersionId,state.organizationId]);
 assert(draftRows.length===1&&isDeepStrictEqual(JSON.parse(draftRows[0].content),fictionalForm),'fictional_form_content_changed');
 const consentRows=await sql("select status,artifact_id from clinical_core.consent_grants where connection_id=:p0::uuid and scope='forms_checkins' order by version desc limit 1",[fixture.connectionId]);
 assert(consentRows.length<=1&&(!consentRows.length||approvedConsentTest&&consentRows[0].status==='granted'),'fictional_forms_consent_state_changed');
 let packetWithoutConsentRefused=false,deniedPacketNotPersisted=false;
 if(!consentRows.length){
  const before=await sql('select count(*)::int as count from clinical_core.intake_packets where connection_id=:p0::uuid',[fixture.connectionId]);
  const deniedPacket=await request('workforce','/clinical-core/workforce/intake-packets',{
   action:'assign',connectionId:fixture.connectionId,label:'Fictional qualification packet',
   forms:[{formVersionId:draftVersionId,required:true}]},409);
  assert(deniedPacket.error==='consent_required','packet_without_consent_not_refused');
  const after=await sql('select count(*)::int as count from clinical_core.intake_packets where connection_id=:p0::uuid',[fixture.connectionId]);
  assert(after[0]?.count===before[0]?.count,'denied_packet_persisted');
  packetWithoutConsentRefused=true;deniedPacketNotPersisted=true;
 }
 const ledger=await sql('select count(*)::int as count,max(version) as latest from clinical_core.schema_migrations');
 assert(ledger[0]?.count===46&&ledger[0]?.latest==='20260930200000','synthetic_migration_refused');
 const link=await sql("select organization_id,consumer_person_id,state from clinical_core.patient_connections where id=:p0::uuid",[fixture.connectionId]);
 assert(link[0]?.organization_id===state.organizationId&&link[0]?.consumer_person_id===state.users.consumer.personId&&link[0]?.state==='verified','connection_fixture_refused');
 const membership=await sql("select role from clinical_core.organization_memberships where organization_id=:p0::uuid and person_id=:p1::uuid",[state.organizationId,state.users.workforce.personId]);
 assert(membership[0]?.role==='practitioner','workforce_membership_refused');
 let intakeJourney=null;
 if(approvedConsentTest){
  const artifacts=await sql("select id,artifact_version,content_sha256,status,approved_by_person_id from clinical_core.consent_artifacts where organization_id=:p0::uuid and scope='forms_checkins' order by created_at desc",[state.organizationId]);
  assert(artifacts.length<=1,'fictional_consent_artifact_ambiguous');
  let artifactId;
  if(artifacts.length){
   const artifact=artifacts[0];
   assert(artifact.artifact_version===consentVersion&&artifact.content_sha256===consentDigest&&artifact.status==='approved'&&artifact.approved_by_person_id===state.users.workforce.personId,'fictional_consent_artifact_changed');
   artifactId=artifact.id;
  }else{
   artifactId=randomUUID();
   await sql("insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values(:p0::uuid,:p1::uuid,'forms_checkins',:p2,:p3,'synthetic-staging','approved',clock_timestamp(),:p4::uuid)",
    [artifactId,state.organizationId,consentVersion,consentDigest,state.users.workforce.personId]);
  }
  const artifactResponse=await fetch(api+'/clinical-core/consumer/consent-artifact?scope=forms_checkins',{headers:{authorization:'Bearer '+tokens.consumer},redirect:'error',signal:AbortSignal.timeout(30000)});
  assert(artifactResponse.status===200,'fictional_artifact_not_visible');
  const visibleArtifact=await artifactResponse.json();
  assert(visibleArtifact.data?.artifactId===artifactId&&visibleArtifact.data?.contentSha256===consentDigest&&visibleArtifact.data?.artifactVersion===consentVersion,'fictional_artifact_mismatch');
  if(!consentRows.length){
   const grant=await request('consumer','/clinical-core/consumer/consents/grant',{connectionId:fixture.connectionId,artifactId,scope:'forms_checkins',method:'patient_app',representativeAuthority:'self'},201);
   assert(grant.data?.status==='granted'&&grant.data?.scope==='forms_checkins','fictional_consent_grant_failed');
  }else assert(consentRows[0].artifact_id===artifactId,'fictional_grant_artifact_changed');
  const priorPackets=await request('workforce','/clinical-core/workforce/intake-packets',{action:'list',connectionId:fixture.connectionId},200);
  const matching=priorPackets.data.packets.filter(packet=>packet.label==='Fictional qualification packet');
  assert(matching.length<=1,'fictional_packet_ambiguous');
  let packetId=matching[0]?.packetId;
  if(!packetId){
   const draftRefusal=await request('workforce','/clinical-core/workforce/intake-packets',{action:'assign',connectionId:fixture.connectionId,label:'Fictional qualification packet',forms:[{formVersionId:draftVersionId,required:true}]},403);
   assert(draftRefusal.error==='operation_refused','unpublished_form_delivered');
   const published=await request('workforce','/clinical-core/workforce/intake-forms',{action:'publish',formVersionId:draftVersionId},200);
   assert(published.data?.status==='published'&&published.data?.formVersionId===draftVersionId,'fictional_form_publish_failed');
   const assigned=await request('workforce','/clinical-core/workforce/intake-packets',{action:'assign',connectionId:fixture.connectionId,label:'Fictional qualification packet',forms:[{formVersionId:draftVersionId,required:true}]},200);
   assert(assigned.data?.status==='open'&&assigned.data?.items.length===1,'fictional_packet_assign_failed');
   packetId=assigned.data.packetId;
  }
  const opened=await request('consumer','/clinical-core/consumer/intake-packets',{action:'open',packetId},200);
  assert(opened.data?.items.length===1&&isDeepStrictEqual(opened.data.items[0].content,fictionalForm),'fictional_packet_content_changed');
  const foreign=await request('foreignConsumer','/clinical-core/consumer/intake-packets',{action:'open',packetId},403);
  assert(foreign.error==='identity_refused'||foreign.error==='operation_refused','foreign_packet_not_refused');
  if(opened.data.status==='open'){
   const item=opened.data.items[0];
   const wrongDigest=await request('consumer','/clinical-core/consumer/intake-packets',{action:'submit',packetId,itemId:item.itemId,contentSha256:'0'.repeat(64),answers:{choice:'one'}},409);
   assert(wrongDigest.error==='conflict','intake_digest_not_checked');
   const submitted=await request('consumer','/clinical-core/consumer/intake-packets',{action:'submit',packetId,itemId:item.itemId,contentSha256:item.contentSha256,answers:{choice:'one'}},200);
   assert(submitted.data?.packetStatus==='completed','fictional_packet_submit_failed');
  }
  const workforceOpen=await request('workforce','/clinical-core/workforce/intake-packets',{action:'open',packetId},200);
  assert(workforceOpen.data?.status==='completed'&&workforceOpen.data?.items[0]?.answers?.choice==='one','fictional_packet_review_failed');
  intakeJourney={consentVersion,consentSha256:consentDigest,artifactId,packetId,completed:true,foreignOwnerRefused:true};
 }
 let programId=randomUUID(),versionId=randomUUID();
 const phases=[{id:'phase-1',title:'Fictional phase',days:1,transition:'scheduled',items:[
  {id:'lesson-a',title:'Fictional lesson',kind:'lesson',instructions:'Read the fictional lesson.',released:true},
  {id:'supp-1',title:'Fictional unresolved product',kind:'supplement',instructions:'Fictional test only.',released:true,
   product:{id:'product-fictional-1',ingredientKeys:['fictional-mineral'],dose:'100 mg',purchaseUrl:null}},
 ]}];
 const content={consumerProgram:{title:'Fictional hosted guide',phases}};
 const previous=await sql("select p.id as program_id,v.id as version_id,v.content,v.status from clinical_core.synthetic_desktop_programs p join clinical_core.synthetic_desktop_program_versions v on v.program_id=p.id where p.organization_id=:p0::uuid and p.name='Fictional hosted program acceptance' and p.created_by_person_id=:p1::uuid and v.version=1",[state.organizationId,state.users.workforce.personId]);
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
 const carts=await request('workforce','/clinical-core/workforce/protocol-carts',{action:'list',programId},200);
 assert(carts.data?.action==='list'&&Array.isArray(carts.data.manifests),'protocol_cart_read_failed');
 const cartBody=JSON.stringify({action:'list',programId});
 const anonymousCarts=await fetch(api+'/clinical-core/workforce/protocol-carts',{method:'POST',headers:{'content-type':'application/json'},body:cartBody,redirect:'error'});
 const consumerCarts=await fetch(api+'/clinical-core/workforce/protocol-carts',{method:'POST',headers:{authorization:'Bearer '+tokens.consumer,'content-type':'application/json'},body:cartBody,redirect:'error'});
 assert((anonymousCarts.status===401||anonymousCarts.status===403)&&(consumerCarts.status===401||consumerCarts.status===403),'protocol_cart_authorization_failed');
 const compiledCart=await request('workforce','/clinical-core/workforce/protocol-carts',{action:'compile',programVersionId:versionId},200);
 assert(compiledCart.data?.action==='compile'&&compiledCart.data?.includedCount===0&&compiledCart.data?.excludedCount===1,'unresolved_cart_line_included');
 const cartManifest=await request('workforce','/clinical-core/workforce/protocol-carts',{action:'read',manifestId:compiledCart.data.manifestId},200);
 assert(cartManifest.data?.lines.length===1&&cartManifest.data.lines[0].itemId==='supp-1'
  &&cartManifest.data.lines[0].included===false&&cartManifest.data.lines[0].exclusionReason==='no_purchase_destination'
  &&cartManifest.data.delivery?.state==='not_implemented','unresolved_cart_line_not_held');
 const replayedCart=await request('workforce','/clinical-core/workforce/protocol-carts',{action:'compile',programVersionId:versionId},200);
 assert(replayedCart.data?.replayed===true&&replayedCart.data?.manifestId===compiledCart.data.manifestId,'cart_replay_created_second_manifest');
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
 // Publish a second fictional version and prove an amendment notice reaches the
 // existing owner without silently replacing the version they accepted.
 const revisedContent=structuredClone(content);
 revisedContent.consumerProgram.phases[0].items[0].instructions='Read the revised fictional lesson.';
 revisedContent.consumerProgram.phases[0].items.push({id:'lesson-b',title:'Another fictional lesson',kind:'lesson',
  instructions:'Read the second fictional lesson.',released:true});
 const revisedRows=await sql('select id,content,status from clinical_core.synthetic_desktop_program_versions where program_id=:p0::uuid and organization_id=:p1::uuid and version=2',[programId,state.organizationId]);
 assert(revisedRows.length<=1,'fictional_amendment_ambiguous');
 let revisedVersionId=revisedRows[0]?.id;
 if(revisedRows.length){
  const stored=typeof revisedRows[0].content==='string'?JSON.parse(revisedRows[0].content):revisedRows[0].content;
  assert(revisedRows[0].status==='published'&&isDeepStrictEqual(stored,revisedContent),'fictional_amendment_changed');
 }else{
  revisedVersionId=randomUUID();
  await sql("insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id) values(:p0::uuid,:p1::uuid,:p2::uuid,2,'published',:p3::jsonb,:p4::uuid)",
   [revisedVersionId,state.organizationId,programId,JSON.stringify(revisedContent),state.users.workforce.personId]);
 }
 const amendmentStatement='Fictional test: one lesson was revised and another was added.';
 const existingNotices=await request('workforce','/clinical-core/workforce/content-revisions',{action:'list'},200);
 const matchingNotices=existingNotices.data?.notices?.filter(n=>n.assignmentId===assignment.data.enrollmentId&&n.statement===amendmentStatement);
 assert(Array.isArray(matchingNotices)&&matchingNotices.length<=1,'fictional_amendment_notice_ambiguous');
 const beforeRevision=await request('consumer','/clinical-core/consumer/programs',{action:'read',enrollmentId:assignment.data.enrollmentId},200);
 const preview=await request('workforce','/clinical-core/workforce/content-revisions',
  {action:'preview',toVersionId:revisedVersionId},200);
 assert(preview.data?.affected===(matchingNotices.length?0:1),'fictional_amendment_preview_affected');
 if(!matchingNotices.length){
  assert(preview.data.assignments.length===1&&preview.data.assignments[0].assignmentId===assignment.data.enrollmentId
   &&preview.data.assignments[0].fromVersion===1&&preview.data.assignments[0].itemsAdded===1
   &&preview.data.assignments[0].itemsRemoved===0&&preview.data.assignments[0].itemsChanged===1,
   'fictional_amendment_preview_counts');
 }
 const noticePublish=await request('workforce','/clinical-core/workforce/content-revisions',{
  action:'publish_notices',toVersionId:revisedVersionId,revisionClass:'correction',statement:amendmentStatement},200);
 assert(noticePublish.data?.noticesCreated===(matchingNotices.length?0:1),'fictional_amendment_duplicate_notice');
 const workforceNotices=await request('workforce','/clinical-core/workforce/content-revisions',{action:'list'},200);
 const noticeRows=workforceNotices.data?.notices?.filter(n=>n.assignmentId===assignment.data.enrollmentId&&n.statement===amendmentStatement);
 assert(Array.isArray(noticeRows)&&noticeRows.length===1&&noticeRows[0].revisionClass==='correction'
  &&noticeRows[0].itemsAdded===1&&noticeRows[0].itemsRemoved===0&&noticeRows[0].itemsChanged===1,
  'fictional_amendment_notice_changed');
 const noticeId=noticeRows[0].noticeId;
 const foreignNotices=await request('foreignConsumer','/clinical-core/consumer/content-revisions',{action:'list'},200);
 assert(!foreignNotices.data?.notices?.some(n=>n.noticeId===noticeId),'fictional_amendment_foreign_read_leaked');
 const foreignAcknowledge=await request('foreignConsumer','/clinical-core/consumer/content-revisions',
  {action:'acknowledge',noticeId},403);
 assert(foreignAcknowledge.error==='operation_refused','fictional_amendment_foreign_acknowledge_allowed');
 const ownerNotices=await request('consumer','/clinical-core/consumer/content-revisions',{action:'list'},200);
 const ownerNotice=ownerNotices.data?.notices?.find(n=>n.noticeId===noticeId);
 if(noticeRows[0].status!=='acknowledged'){
  assert(ownerNotice?.assignmentId===assignment.data.enrollmentId&&ownerNotice.revisionClass==='correction'
   &&ownerNotice.itemsAdded===1&&ownerNotice.itemsRemoved===0&&ownerNotice.itemsChanged===1
   &&ownerNotice.requiresAcknowledgement===false,'fictional_amendment_owner_notice_missing');
  const delivered=await request('workforce','/clinical-core/workforce/content-revisions',{action:'list'},200);
  assert(delivered.data.notices.find(n=>n.noticeId===noticeId)?.status==='delivered','fictional_amendment_delivery_missing');
  const acknowledged=await request('consumer','/clinical-core/consumer/content-revisions',
   {action:'acknowledge',noticeId},200);
  assert(acknowledged.data?.status==='acknowledged','fictional_amendment_acknowledgement_failed');
 }else assert(!ownerNotice,'acknowledged_amendment_still_listed');
 const afterRevision=await request('consumer','/clinical-core/consumer/programs',{action:'read',enrollmentId:assignment.data.enrollmentId},200);
 assert(afterRevision.data?.sourceDigest===beforeRevision.data?.sourceDigest
  &&isDeepStrictEqual(afterRevision.data?.assignment,beforeRevision.data?.assignment),
  'fictional_amendment_replaced_accepted_program');
 // A fictional assignment is already present. Exercise the actual owner-to-clinic
 // dispute lifecycle without creating another chart or claiming a clinical correction.
 const subjectId=assignment.data.enrollmentId;
 const consumerDisputes=await request('consumer','/clinical-core/consumer/disputes',{action:'list'},200);
 const prior=consumerDisputes.data?.disputes?.filter(d=>d.subjectKind==='program_assignment'&&d.subjectId===subjectId);
 assert(Array.isArray(prior)&&prior.length<=1,'fictional_dispute_ambiguous');
 const foreignRaise=await request('foreignConsumer','/clinical-core/consumer/disputes',{
  action:'raise',subjectKind:'program_assignment',subjectId,reasonCode:'other',statement:'Fictional foreign-owner refusal.'},403);
 assert(foreignRaise.error==='operation_refused','foreign_dispute_not_refused');
 let disputeId=prior[0]?.disputeId;
 if(!disputeId){
  const raised=await request('consumer','/clinical-core/consumer/disputes',{
   action:'raise',subjectKind:'program_assignment',subjectId,reasonCode:'other',
   statement:'Fictional test: please review this sample assignment.'},200);
  assert(raised.data?.status==='open'&&raised.data.disputeId,'fictional_dispute_raise_failed');
  disputeId=raised.data.disputeId;
 }
 const workforceDisputes=await request('workforce','/clinical-core/workforce/disputes',{action:'list'},200);
 const workforceEntry=workforceDisputes.data?.disputes?.filter(d=>d.disputeId===disputeId);
 assert(Array.isArray(workforceEntry)&&workforceEntry.length===1&&workforceEntry[0].subjectId===subjectId,'fictional_dispute_queue_failed');
 let current=workforceEntry[0];
 if(current.status==='open'){
  const acknowledged=await request('workforce','/clinical-core/workforce/disputes',{
   action:'acknowledge',disputeId,expectedRevision:current.revision},200);
  assert(acknowledged.data?.status==='acknowledged','fictional_dispute_acknowledge_failed');
  current=acknowledged.data;
 }
 if(current.status==='acknowledged'){
  const resolved=await request('workforce','/clinical-core/workforce/disputes',{
   action:'resolve',disputeId,expectedRevision:current.revision,resolution:'upheld',
   clinicianResponse:'Fictional test: the sample assignment is unchanged; the concern remains on record.'},200);
  assert(resolved.data?.status==='resolved'&&resolved.data.resolution==='upheld','fictional_dispute_resolution_failed');
 }else assert(current.status==='resolved'&&current.resolution==='upheld','fictional_dispute_state_changed');
 const finalDisputes=await request('consumer','/clinical-core/consumer/disputes',{action:'list'},200);
 const finalEntry=finalDisputes.data?.disputes?.find(d=>d.disputeId===disputeId);
 assert(finalEntry?.status==='resolved'&&finalEntry.resolution==='upheld'
  &&finalEntry.clinicianResponse==='Fictional test: the sample assignment is unchanged; the concern remains on record.',
  'fictional_dispute_owner_readback_failed');
 const foreignDisputes=await request('foreignConsumer','/clinical-core/consumer/disputes',{action:'list'},200);
 assert(!foreignDisputes.data?.disputes?.some(d=>d.disputeId===disputeId),'fictional_dispute_foreign_read_leaked');
 const held=await request('consumer','/clinical-core/consumer/programs',{action:'complete',enrollmentId:assignment.data.enrollmentId,
  sourceDigest:assignment.data.sourceDigest,expectedRevision:revision,itemId:'supp-1'},403);
 assert(held.error==='identity_refused','held_product_completed');
 console.log(JSON.stringify({verdict:'pass',account,phiAllowed:false,deployedSourceCommit,deployedArtifactSha256,
  firstRequestObservation,
  observed:{consumerAssignments:list.data.assignments.length,foreignAssignments:other.data.assignments.length,publishedPrograms:programs.data.programs.length,
   consumerRoleRefused:true,workforceRoleRefused:true,unauthenticatedRefused:true,fictionalAssignmentAccepted:true,foreignOwnerRefused:true,unresolvedSupplementHeld:true,
   ownerErasureHistoryReadable:true,foreignErasureHistoryCount:otherErasures.data.erasures.length,ownerAssignmentExported:true,foreignAssignmentExportEmpty:true,
   calendarConnected:calendar.data.connected,calendarUnauthenticatedRefused:true,
   consultLinkCount:consultLinks.data.links.length,consultRequestCount:consultRequests.data.requests.length,
   intakeFormCount:intakeForms.data.forms.length,workforcePacketCount:workforcePackets.data.packets.length,
   ownerPacketCount:consumerPackets.data.packets.length,foreignPacketCount:foreignPackets.data.packets.length,
   intakeRoleRefused:true,intakeUnauthenticatedRefused:true,publicConsultRouteWithheld:true,
   fictionalFormCreatedOrReused:true,packetWithoutConsentRefused,deniedPacketNotPersisted,intakeJourney,
   finalDomainReadRoutes:finalReads.length+1,finalDomainRoleAndAnonymousRefusals:finalReads.length+1,
   fictionalCartCompiledWithUnresolvedProductExcluded:true,fictionalCartReplayIdempotent:true,cartDeliveryNotImplemented:true,
   fictionalDisputeRaisedAcknowledgedAndUpheld:true,fictionalDisputeOwnerReadback:true,fictionalDisputeForeignOwnerRefused:true,
   fictionalAmendmentDeliveredAndAcknowledged:true,fictionalAmendmentReplayIdempotent:true,fictionalAmendmentOriginalPreserved:true,
   fictionalNoteTemplatePublishedAndResolved:true,fictionalNoteTemplateDigestRefusalTested:true},
  evidenceScope:approvedConsentTest?'hosted fictional program assignment and amendment notice, owner consent/form-packet, program dispute and practitioner note-template journey; no generated note, public consult endpoint, governed catalog release, provider OAuth, device test or PHI approval':'hosted fictional program assignment and amendment notice, program dispute and practitioner note-template journey, draft-only intake form and consent refusal; no generated note, public consult endpoint, form publication, packet delivery, governed catalog release, provider OAuth, device test or PHI approval'}));
}
main().catch(error=>{console.error(JSON.stringify({verdict:'blocked',firstRequestObservation,error:/^[a-z0-9_]+$/.test(error.message)?error.message:'hosted_verification_failed'}));process.exitCode=1;});
