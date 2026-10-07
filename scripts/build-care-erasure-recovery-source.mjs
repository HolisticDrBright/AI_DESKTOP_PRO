/** Blocked source libraries only. No deployed handler, operator, AWS request, or approval. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

export const CARE_ERASURE_RECOVERY_PARENT=Object.freeze({
 count:46,historySha256:'52f2027ba0db0fd570bc4714fadf5ccd39e2caabf992081cb24be56497a52017',
 terminalVersion:'20261006040000',terminalSha256:'3890daeb708511a0f651abd95456906048fb9f4a7bc1ef754b731e9d673dab91',
});
export const CARE_ERASURE_RECOVERY_SUCCESSOR=Object.freeze({version:'20261007010000',name:'synthetic_care_erasure_intents',
 sqlSha256:'4be2ca72b0486bec171f16c5299c898d70bfbdbfd3143c4bb216fccc329299ec'});
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const normalized=value=>value.replace(/\r\n?/g,'\n');
export function sourceMapping(migrations,sql,sourceCommit,sourceDirty){
 const p=CARE_ERASURE_RECOVERY_PARENT;
 if(!Array.isArray(migrations)||migrations.length!==p.count
  ||!migrations.every((m,i)=>/^\d{14}$/.test(m.version)&&/^[a-z0-9_]+$/.test(m.name)
    &&m.sha256===digest(m.sql)&&(!i||m.version>migrations[i-1].version))
  ||digest(JSON.stringify(migrations.map(({version,name,sha256})=>({version,name,sha256}))))!==p.historySha256
  ||migrations.at(-1).version!==p.terminalVersion||migrations.at(-1).sha256!==p.terminalSha256
  ||!/^[a-f0-9]{40}$/.test(sourceCommit)||typeof sourceDirty!=='boolean')throw new Error('care_erasure_recovery_parent_refused');
 if(typeof sql!=='string'||sql!==normalized(sql)||digest(sql)!==CARE_ERASURE_RECOVERY_SUCCESSOR.sqlSha256
  ||!sql.startsWith('-- BLOCKED SYNTHETIC SOURCE CANDIDATE.')
  ||!/alter function clinical_core\.care_data_erasure_request\(jsonb\) rename to care_data_erasure_request_v1_terminal;/.test(sql)
  ||!/revoke all on function clinical_core\.care_data_erasure_request_v1_terminal\(jsonb\) from public,clinical_core_api;/.test(sql))
  throw new Error('care_erasure_recovery_overlay_refused');
 const before=migrations.map(({version,name,sha256})=>({version,name,sha256}));
 const alias=before.find(v=>v.version==='20260821049700');
 if(!alias)throw new Error('care_erasure_recovery_parent_refused');
 const liveBefore=[...before,{...alias,version:'20260902230000'}].sort((a,b)=>a.version<b.version?-1:a.version>b.version?1:0);
 const successor={version:CARE_ERASURE_RECOVERY_SUCCESSOR.version,name:CARE_ERASURE_RECOVERY_SUCCESSOR.name,sha256:digest(sql)};
 if(digest(JSON.stringify(liveBefore))!=='99ad59a94bab717a4e1299979db177394e931c9ebb7f40aa8be1ba1d99d52148')
  throw new Error('care_erasure_recovery_parent_refused');
 return {contract:'care-erasure-recovery-source-candidate/1',status:'blocked_source_only',sourceCommit,sourceDirty,
  deployable:false,canonicalRegistered:false,operatorExists:false,preservingOperatorLibrary:true,
  inspectionRehearsalExecutable:true,lastingUpgradeExecutable:false,handlerIntegrated:true,matchedMobileRelease:false,
  clientIntegration:'requires_matched_v2_source_evidence',
  hostedVerified:false,deviceVerified:false,productionApproved:false,phiAllowed:false,
  predecessor:p,overlay:{file:'care-erasure-intents.sql',sha256:digest(sql),bytes:Buffer.byteLength(sql)},
  candidateLedgerMapping:{migration:successor,sourceBeforeCount:46,sourceAfterCount:47,liveBeforeCount:47,liveAfterCount:48,
   sourceAfterSha256:digest(JSON.stringify([...before,successor])),liveBeforeSha256:digest(JSON.stringify(liveBefore)),
   liveAfterSha256:digest(JSON.stringify([...liveBefore,successor])),historicalAliasPreserved:true,canonicalRegistered:false},
  futureTarget:{account:'588966314750',region:'us-east-2',database:'clinical_core',execution:'synthetic-staging',
   qualificationDatabaseRefused:'clinical_core_qualification',productionRefused:true},
  recoverySemantics:{registerBeforeErase:true,automaticDestructiveReplay:false,immutableIntents:true,
   terminalHistoryPreserved:true,unknownAbsenceIsClearance:false,legacyUuidFabrication:false,
   discoveryCoverage:'committed_owner_records_not_global_clearance',wholeScanIsAtomic:false},
  retention:{intentRecords:'immutable_no_deletion_authority',reviewedPolicy:false,
   clinicDisposition:'not_implemented_by_this_candidate',providerCopies:'not_covered'},
  remaining:['canonical migration registration and lasting preserving operator gated by actual API recovery',
   'API action routing plus exact code/schema release mapping and real API recovery rehearsal',
   'bind V2 prepare-before-dispatch, durable journal, owner discovery and recovery UI to this exact server release',
   'real concurrent requests, lost replies, second-device recovery and denied-owner hosted acceptance',
   'matched mobile/Desktop/API release and physical device verification',
   'separate security, retention, provider and PHI activation approvals']};
}
export async function buildSource(){
 if(process.argv.length!==2)throw new Error('care_erasure_recovery_arguments_refused');
 const directory='infra/aws-clinical-core/migrations/';
 const manifest=JSON.parse(readFileSync(directory+'manifest.json','utf8'));
 if(manifest.contract_version!=='clinical-core-migrations/1')throw new Error('care_erasure_recovery_manifest_refused');
 const migrations=manifest.migrations.map(m=>{
  if(!/^\d{14}_[a-z0-9_]+\.sql$/.test(m.file)||!m.file.startsWith(m.version+'_'))throw new Error('care_erasure_recovery_manifest_refused');
  const sql=normalized(readFileSync(directory+m.file,'utf8'));
  return {version:m.version,name:m.file.slice(15,-4),sql,sha256:digest(sql)};
 });
 const sql=normalized(readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8'));
 const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const sourceDirty=!!execFileSync('git',['status','--porcelain','--untracked-files=all','--',
  'src','scripts','infra','package.json','package-lock.json','.gitattributes','.github'],{encoding:'utf8'}).trim();
 const mapping=sourceMapping(migrations,sql,sourceCommit,sourceDirty);
 const out=resolve('dist/aws-clinical-core/care-erasure-recovery-source');mkdirSync(out,{recursive:true});
 const libraries=[];
 for(const [file,entry] of [['preserving-operator-library.cjs','src/server/clinical-core/care-erasure-intent-upgrade.ts'],
  ['service-library.cjs','src/server/clinical-core/care-erasure-recovery.ts'],
  ['contract-library.cjs','src/contracts/careErasureRecovery.ts']]){
  await build({entryPoints:[entry],outfile:resolve(out,file),bundle:true,platform:'node',target:'node22',format:'cjs',legalComments:'none'});
  libraries.push({file,sha256:digest(readFileSync(resolve(out,file)))});
 }
 writeFileSync(resolve(out,'care-erasure-intents.sql'),sql);
 writeFileSync(resolve(out,'manifest.json'),JSON.stringify({...mapping,libraries},null,2)+'\n');
 console.log(JSON.stringify({built:true,status:mapping.status,sourceCommit,sourceDirty,deployable:false,
  overlaySha256:mapping.overlay.sha256,phiAllowed:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await buildSource();
