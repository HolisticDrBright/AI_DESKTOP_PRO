/** Fixed catalog proposal orchestration. Ports are fictional tests only.
 * No public AWS target, stored approval or execution authority is exposed. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {refuseRegistered} from './synthetic-care-registered-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {verifyCatalogRuntimePredecessorControl} from './catalog-runtime-preflight.mjs';
import {verifyCatalogRuntimeUploadPreflight} from './catalog-runtime-upload.mjs';
import {assertSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
import {catalogRuntimeCodeChangeInputs,catalogRuntimeChangeSetBinding,verifyCatalogRuntimeProposalViews} from './catalog-runtime-code-change.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_proposal_'+code);};
export async function runCatalogRuntimeProposal(suppliedCandidate,suppliedCurrent,sourceText,suppliedPreparation,suppliedArtifact,port){
 const candidate=structuredClone(suppliedCandidate),current=structuredClone(suppliedCurrent),
  preparation=structuredClone(suppliedPreparation),artifact=structuredClone(suppliedArtifact);
 for(const field of ['bundle','zip','releaseBytes','manifestBytes'])candidate[field]=Buffer.from(candidate[field]);
 const source=JSON.parse(sourceText),input=catalogRuntimeCodeChangeInputs(sourceText,candidate,current,preparation,artifact,port.now()),
  fixed=catalogRuntimeChangeSetBinding(input,current,artifact);
 const first=structuredClone(await port.identity());assertSyntheticMemberIdentity(first);
 let activePreparation=preparation,renewals=0;
 const unchangedPrincipal=async()=>{
  await port.unchanged();const caller=await port.identity();assertSyntheticMemberIdentity(caller);
  check(canonical(caller)===canonical(first),'principal_changed');
 };
 const guard=async(allowRenewal=true,publication=false)=>{
  await unchangedPrincipal();
  // Renew only elapsed time, never a caught validation failure. The public
  // constructor performs a complete new read-only preflight, not a timestamp
  // edit, stored report or replay of an admitted create.
  const time=Date.parse(activePreparation.observedAt),now=port.now();
  // A report near the deadline can expire during its own durable readback and
  // final control check. Before publication, obtain a fresh complete observer
  // result when time has elapsed. Never renew after saving the report: its
  // recorded preflight must remain the one the final strict guard verifies.
  const publicationRefresh=publication&&typeof port.refreshPreflight==='function'&&now>time;
  if(Number.isFinite(time)&&Number.isFinite(now)&&(now-time>120000||publicationRefresh)){
   check(allowRenewal&&typeof port.refreshPreflight==='function'&&renewals<4,'preflight_renewal_required');
   const started=port.now(),fresh=structuredClone(await port.refreshPreflight());
   await unchangedPrincipal();verifyCatalogRuntimeUploadPreflight(fresh,candidate,current,port.now());
   check(Date.parse(fresh.observedAt)>=started&&canonical(fresh.control)===canonical(preparation.control),'preflight_renewal_changed');
   verifyCareRegisteredDatabase(fresh.databaseBefore,current,started,port.now());
   verifyCareRegisteredDatabase(fresh.databaseAfter,current,started,port.now());
   activePreparation=fresh;renewals++;
  }
  verifyCatalogRuntimeUploadPreflight(activePreparation,candidate,current,port.now());
  const raw=await port.control();check(canonical(verifyCatalogRuntimePredecessorControl(raw,source))===canonical(activePreparation.control),'control_changed');
  await unchangedPrincipal();verifyCatalogRuntimeUploadPreflight(activePreparation,candidate,current,port.now());return raw;
 };
 await guard();
 const listing=await port.list(structuredClone(fixed));
 check(Array.isArray(listing?.Summaries)&&listing.Summaries.length<=2000&&!listing.NextToken
  &&listing.Summaries.every(s=>typeof s.ChangeSetName==='string'&&typeof s.ChangeSetId==='string')
  &&new Set(listing.Summaries.map(s=>s.ChangeSetId)).size===listing.Summaries.length,'listing');
 const found=listing.Summaries.filter(s=>s.ChangeSetName===fixed.name);check(found.length<=1,'ambiguous');
 await port.writeInput(structuredClone(fixed),structuredClone(input));await guard();let id=found[0]?.ChangeSetId;
 if(!id){
  await port.admit({stage:'catalog_runtime_change_set_create_admitted',stackId:fixed.stackId,name:fixed.name,clientToken:fixed.digest});
  await guard(false);const created=await port.create(structuredClone(fixed),structuredClone(input));check(created?.StackId===fixed.stackId,'created_identity');id=created.Id;
 }
 check(typeof id==='string'&&new RegExp('^arn:aws:cloudformation:'+P.region+':'+P.account+':changeSet/'+fixed.name+'/[A-Za-z0-9-]{1,128}$').test(id),'identity');
 const binding={...fixed,id};await port.record({stage:'catalog_runtime_change_set_observed',id,name:fixed.name,reused:found.length===1});
 let detailed;
 for(let n=0;n<20;n++){
  detailed=await port.describe(binding,true);
  if(!['CREATE_PENDING','CREATE_IN_PROGRESS'].includes(detailed?.Status))break;
  await port.wait(2000);
 }
 const raw=await guard(true,true),summary=await port.describe(binding,false);
 // A complete preflight can take minutes. Its earlier proposal views cannot
 // establish that the proposal is still unexecuted when the report is saved.
 detailed=await port.describe(binding,true);
 const actualTemplate=await port.template(binding);
 const projection=verifyCatalogRuntimeProposalViews(summary,detailed,actualTemplate,input,binding,raw,sourceText,
  activePreparation,current,candidate,artifact,port.now());
 const report={contract:'synthetic-catalog-runtime-code-change/1',observedAt:new Date(port.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,current,artifact,projection,
  stackId:fixed.stackId,changeSetId:id,changeSetName:fixed.name,changeSetCreated:found.length===0,reused:found.length===1,
  preflightObservedAt:activePreparation.observedAt,preflightSha256:sha256(canonical(activePreparation)),preflightRenewals:renewals,
  changeSetExecutionStatus:detailed.ExecutionStatus,executionAdmissible:false,deployed:false,schemaChanged:false,
  recoveryRehearsed:false,hostedAcceptance:false,releaseAccepted:false,phiAllowed:false,paidMobileBuildStarted:false};
 await port.saveReport(structuredClone(fixed),structuredClone(report));await guard(false);await port.record({stage:'catalog_runtime_change_set_verified_unexecuted',
  id,summarySha256:projection.summarySha256,propertyValuesSha256:projection.propertyValuesSha256});return report;
}
