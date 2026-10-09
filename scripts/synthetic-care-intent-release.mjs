/** Separate intent-aware code artifact. Existing parent artifacts and operators stay immutable. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CARE_RELEASE as P,careMigrationBinding,careMobileBinding,careSourceSnapshot,
 normalizedText,sha256,careReleaseZip,buildCareIdentityBundle} from './synthetic-care-release.mjs';
import {readHistoricalCareParentMigrations} from './care-canonical-migrations.mjs';
import {sourceMapping} from './build-care-erasure-recovery-source.mjs';
import {DEPLOYED_CARE} from './verify-deployed-synthetic-care.mjs';

export const INTENT_RELEASE=Object.freeze({contract:'synthetic-care-intent-release/1',
 protocol:'request-id-intent-discovery-settlement/1',
 sourceAfter:'02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7',
 liveAfter:'447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50'});
export const refuseIntent=reason=>{throw new Error('synthetic_care_intent_release_refused:'+reason);};
const canonical=value=>JSON.stringify(value);
export function careIntentMigrationBinding(root,historicalSourceOnly=false){
 const parent=careMigrationBinding(root,historicalSourceOnly),dir='infra/aws-clinical-core/migrations/';
 const rows=historicalSourceOnly?readHistoricalCareParentMigrations(root):JSON.parse(normalizedText(root,dir+'manifest.json')).migrations.map(m=>{
  const sql=normalizedText(root,dir+m.file);
  return {version:m.version,name:m.file.slice(15,-4),sql,sha256:sha256(sql)};
 });
 const sql=normalizedText(root,'infra/aws-clinical-core/source-candidates/care-erasure-intents.sql');
 const mapping=sourceMapping(rows,sql,'0'.repeat(40),false).candidateLedgerMapping;
 if(mapping.sourceAfterSha256!==INTENT_RELEASE.sourceAfter||mapping.liveAfterSha256!==INTENT_RELEASE.liveAfter)
  refuseIntent('migration_mapping');
 return {parent,overlay:mapping.migration,overlayBytes:Buffer.byteLength(sql),
  sourceBefore:parent.sourceAfter,sourceAfter:mapping.sourceAfterSha256,
  liveBefore:parent.liveAfter,liveAfter:mapping.liveAfterSha256,reference:parent.reference,
  sourceBeforeCount:46,sourceAfterCount:47,liveBeforeCount:47,liveAfterCount:48,
  tablesBefore:88,tablesAfter:89,historicalAliasPreserved:true,canonicalRegistered:false};
}
export function careIntentMobileBinding(root,desktopRoot){
 const mobile=careMobileBinding(root,desktopRoot),contract=normalizedText(root,'expo/contracts/careErasureRecovery.ts');
 if(contract!==normalizedText(desktopRoot,'src/contracts/careErasureRecovery.ts'))refuseIntent('recovery_contract');
 return {...mobile,recoveryContractSha256:sha256(contract),
  recoveryUiSha256:sha256(normalizedText(root,'expo/components/CareErasureRequestsList.tsx'))};
}
export function careIntentCurrent(root,mobileRoot){
 return {desktop:careSourceSnapshot(root,'desktop'),mobile:careIntentMobileBinding(mobileRoot,root),
  migrations:careIntentMigrationBinding(root),
  templateSha256:sha256(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'))};
}
function assertCurrent(c){
 const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 const snapshot=v=>v?.clean===true&&/^[a-f0-9]{40}$/.test(v.commit)&&hash(v.sha256)&&Number.isSafeInteger(v.files)&&v.files>0;
 if(!snapshot(c?.desktop)||!snapshot(c.mobile?.source)||c.mobile.built!==false||c.mobile.deviceVerified!==false
  ||!['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].every(k=>hash(c.mobile[k]))
  ||!hash(c.templateSha256)||c.migrations?.canonicalRegistered!==false
  ||c.migrations.sourceBefore!==P.sourceAfter||c.migrations.liveBefore!==P.liveAfter
  ||c.migrations.sourceAfter!==INTENT_RELEASE.sourceAfter||c.migrations.liveAfter!==INTENT_RELEASE.liveAfter
  ||c.migrations.reference!==P.reference||c.migrations.sourceBeforeCount!==46||c.migrations.sourceAfterCount!==47
  ||c.migrations.liveBeforeCount!==47||c.migrations.liveAfterCount!==48||c.migrations.tablesBefore!==88||c.migrations.tablesAfter!==89)
  refuseIntent('source_binding');
}
export function createCareIntentCandidate(current,bundle){
 assertCurrent(current);
 if(!Buffer.isBuffer(bundle)||bundle.length===0||bundle.length>10*1024*1024)refuseIntent('bundle');
 const release={contract:INTENT_RELEASE.contract,execution:'synthetic-staging',phiAllowed:false,...current,
  predecessor:{...DEPLOYED_CARE,codeSha256:Buffer.from(DEPLOYED_CARE.zip,'hex').toString('base64')},
  bundleSha256:sha256(bundle),erasureProtocol:INTENT_RELEASE.protocol,legacyErasureAdmission:false,
  rollout:{codeBeforeSchema:true,newActionsUnavailableUntilSchema:true,existingTerminalHistoryPreserved:true,
   lastingSchemaUpgradeAuthorized:false,freshCompatibleRecoveryRequired:true},
  rollback:{databaseDownMigrationAllowed:false,idlessApiAllowed:false,parentApiAllowedAfterIntentUpgrade:false,
   intentCompatibleReForwardRequired:true,rehearsed:false},
  deployed:false,schemaChanged:false,hostedAcceptance:false,phiActivation:false};
 const zip=careReleaseZip(bundle,release),zipSha256=sha256(zip);
 const manifest={...release,zipSha256,zipBytes:zip.length,
  key:`clinical-core/authenticated-api/care-intent-release/${current.desktop.commit}/${zipSha256}.zip`};
 return {release,manifest,zip,bundle};
}
export function verifyCareIntentCandidate(manifest,release,bundle,zip,current){
 const expected=createCareIntentCandidate(current,bundle);
 if(canonical(manifest)!==canonical(expected.manifest)||canonical(release)!==canonical(expected.release)
  ||!Buffer.isBuffer(zip)||!zip.equals(expected.zip))refuseIntent('candidate_bytes_or_binding');
}
export async function buildCareIntentCandidate(root,mobileRoot){
 const current=careIntentCurrent(root,mobileRoot),bundle=await buildCareIdentityBundle(root);
 const candidate=createCareIntentCandidate(current,bundle);
 if(canonical(current)!==canonical(careIntentCurrent(root,mobileRoot)))refuseIntent('source_changed');
 return candidate;
}
export function readCareIntentCandidate(directory){
 return {manifest:JSON.parse(readFileSync(resolve(directory,'artifact-manifest.json'),'utf8')),
  release:JSON.parse(readFileSync(resolve(directory,'release.json'),'utf8')),
  bundle:readFileSync(resolve(directory,'index.js')),zip:readFileSync(resolve(directory,'candidate.zip'))};
}
