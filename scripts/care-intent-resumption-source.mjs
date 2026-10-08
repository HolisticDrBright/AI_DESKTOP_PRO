/** Read-only source qualification for interrupted releases. Git bytes identify
 * the deployed application; the clean checkout identifies the new operator.
 * This module has no AWS, custody, schema mutation, or activation authority. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {careSourcePaths,careSourceEntry,sha256,buildCareIdentityBundle} from './synthetic-care-release.mjs';
import {careIntentCurrent,verifyCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('resume_source_'+code);};
const limit=256*1024*1024;
const git=(root,args,input)=>{
 try{return execFileSync('git',args,{cwd:root,input,timeout:30000,maxBuffer:limit,windowsHide:true,
  stdio:['pipe','pipe','pipe']});}catch{refuseIntent('resume_source_git');}
};
/** Parse Git's size-framed binary batch, never line-split blob contents. The
 * object digest is independently checked before any normalized source digest. */
export function parseCareGitBlobs(bytes,objects){
 check(Buffer.isBuffer(bytes)&&bytes.length<=limit&&Array.isArray(objects)&&objects.length>0&&objects.length<=20000,'batch');
 const result=new Map();let offset=0;
 for(const oid of objects){
  check(/^[a-f0-9]{40}$/.test(oid)&&!result.has(oid),'object_id');
  const end=bytes.indexOf(10,offset);check(end>=offset&&end-offset<=100,'header');
  const match=/^([a-f0-9]{40}) blob (0|[1-9][0-9]{0,8})$/.exec(bytes.subarray(offset,end).toString('ascii'));
  check(match?.[1]===oid,'object_header');const size=Number(match[2]);
  check(Number.isSafeInteger(size)&&size<=16*1024*1024&&end+1+size<bytes.length,'object_size');
  const data=bytes.subarray(end+1,end+1+size);
  check(bytes[end+1+size]===10,'object_separator');
  const digest=createHash('sha1').update(Buffer.from(`blob ${size}\0`)).update(data).digest('hex');
  check(digest===oid,'object_digest');result.set(oid,Buffer.from(data));offset=end+size+2;
 }
 check(offset===bytes.length,'trailing_bytes');return result;
}
export function readHistoricalCareSource(root,kind,commit){
 check(typeof commit==='string'&&/^[a-f0-9]{40}$/.test(commit),'commit');
 // No refs, abbreviated commits, tags, future branches or report-provided trees.
 git(root,['merge-base','--is-ancestor',commit,'HEAD']);
 const listing=git(root,['ls-tree','-r','-z',commit,'--',...careSourcePaths(kind)]);
 check(listing.length>0&&listing.length<=8*1024*1024,'tree_size');
 const rows=listing.toString('utf8').split('\0').filter(Boolean).map(line=>{
  const m=/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(line);
  check(m&&!/[\x00-\x1f\x7f\\:]/.test(m[3])&&!m[3].startsWith('/')
   &&!m[3].split('/').some(s=>s==='.'||s==='..'||s.length===0),'tree_entry');
  return {file:m[3],oid:m[2]};
 }).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
 check(rows.length<=20000&&new Set(rows.map(r=>r.file)).size===rows.length,'tree_duplicates');
 const objects=[...new Set(rows.map(r=>r.oid))];
 const blobs=parseCareGitBlobs(git(root,['cat-file','--batch'],objects.join('\n')+'\n'),objects);
 const entries=rows.map(r=>careSourceEntry(r.file,blobs.get(r.oid)));
 // The original snapshot classified these text formats as byte-exact. Git
 // checkout may have converted their LF blobs to CRLF on Windows. Reconstruct
 // one explicit whole-checkout representation, never per-file guesses fitted
 // to a desired digest. Canonical Git entries remain the runtime comparison.
 const legacyRows=rows.filter(r=>/\.(?:csv|lock|toml|patch|py)$/.test(r.file)
  ||/(?:^|\/)(?:Dockerfile|\.dockerignore|\.easignore|\.gitignore)$/.test(r.file));
 const attrs=new Map();
 if(legacyRows.length){
  const records=git(root,['check-attr','--source='+commit,'-z','--stdin','text','eol','filter','working-tree-encoding'],
   legacyRows.map(r=>r.file).join('\0')+'\0').toString('utf8').split('\0');
  check(records.pop()===''&&records.length===legacyRows.length*12,'attributes');
  const wanted=new Set(legacyRows.map(r=>r.file));
  for(let n=0;n<records.length;n+=3){const [file,key,value]=records.slice(n,n+3);
   check(wanted.has(file)&&['text','eol','filter','working-tree-encoding'].includes(key),'attribute_record');
   if(!attrs.has(file))attrs.set(file,{});check(!Object.hasOwn(attrs.get(file),key),'attribute_duplicate');attrs.get(file)[key]=value;
  }
 }
 const converted=[];
 const windowsEntries=rows.map(r=>{
  const bytes=blobs.get(r.oid),a=attrs.get(r.file);let data=bytes;
  if(a&&a.text!=='unset'&&a.eol!=='lf'){
   check(['set','auto','unspecified'].includes(a.text)&&['crlf','unspecified'].includes(a.eol)
    &&['unset','unspecified'].includes(a.filter)&&['unset','unspecified'].includes(a['working-tree-encoding']),'attribute_conversion');
   // NUL, malformed UTF-8, embedded CR or unknown formats are not text conversion candidates.
   if(!bytes.includes(0)&&!bytes.includes(13)&&Buffer.from(bytes.toString('utf8')).equals(bytes)&&bytes.includes(10)){
    data=Buffer.from(bytes.toString('utf8').replaceAll('\n','\r\n'));converted.push(r.file);
   }
  }
  return careSourceEntry(r.file,data);
 });
 const snapshot=values=>({commit,clean:true,files:values.length,sha256:sha256(JSON.stringify(values))});
 return {snapshot:snapshot(entries),windowsSnapshot:snapshot(windowsEntries),windowsConvertedFiles:converted,entries};
}
export function verifyCareHistoricalSnapshot(history,expected){
 if(canonical(history.snapshot)===canonical(expected))return 'canonical-git';
 check(canonical(history.windowsSnapshot)===canonical(expected),'historical_snapshot');
 return 'windows-crlf-legacy-text';
}
const runtimePath=(kind,file)=>kind==='desktop'
 ? file.startsWith('src/')||file.startsWith('infra/')||['package.json','package-lock.json','.gitattributes'].includes(file)
 : file.startsWith('data/')||file.startsWith('scripts/')
  ||file.startsWith('expo/')&&file!=='expo/docs/six-phase-current-evidence-2026-10-05.md'
  ||['package.json','package-lock.json','bun.lock','.gitattributes'].includes(file);
export function verifyCareRuntimeEntries(kind,application,operator){
 check(['desktop','v2'].includes(kind)&&Array.isArray(application)&&Array.isArray(operator),'runtime_entries');
 for(const entries of [application,operator])check(entries.length>0&&new Set(entries.map(e=>e.file)).size===entries.length
  &&entries.every(e=>typeof e.file==='string'&&/^[a-f0-9]{64}$/.test(e.sha256)),'runtime_shape');
 const filtered=entries=>entries.filter(e=>runtimePath(kind,e.file));
 const old=filtered(application),now=filtered(operator);
 check(old.length>0&&canonical(old)===canonical(now),'runtime_changed');
 return {files:now.length,sha256:sha256(canonical(now))};
}
/** Verify from fresh local Git, disk and build observations. The returned
 * distinction is not proof of what AWS runs; fresh service readbacks are owed. */
export async function qualifyCareIntentResumptionSource(root,mobileRoot,candidate){
 const operatorCurrent=careIntentCurrent(root,mobileRoot);
 check(candidate?.release?.desktop&&candidate.release.mobile?.source,'candidate');
 const applicationDesktop=readHistoricalCareSource(root,'desktop',candidate.release.desktop.commit);
 const applicationMobile=readHistoricalCareSource(mobileRoot,'v2',candidate.release.mobile.source.commit);
 const sourceRepresentations={applicationDesktop:verifyCareHistoricalSnapshot(applicationDesktop,candidate.release.desktop),
  applicationMobile:verifyCareHistoricalSnapshot(applicationMobile,candidate.release.mobile.source)};
 const operatorDesktop=readHistoricalCareSource(root,'desktop',operatorCurrent.desktop.commit);
 const operatorMobile=readHistoricalCareSource(mobileRoot,'v2',operatorCurrent.mobile.source.commit);
 sourceRepresentations.operatorDesktop=verifyCareHistoricalSnapshot(operatorDesktop,operatorCurrent.desktop);
 sourceRepresentations.operatorMobile=verifyCareHistoricalSnapshot(operatorMobile,operatorCurrent.mobile.source);
 const runtime={desktop:verifyCareRuntimeEntries('desktop',applicationDesktop.entries,operatorDesktop.entries),
  mobile:verifyCareRuntimeEntries('v2',applicationMobile.entries,operatorMobile.entries)};
 const applicationCurrent={...operatorCurrent,desktop:structuredClone(candidate.release.desktop),
  mobile:{...operatorCurrent.mobile,source:structuredClone(candidate.release.mobile.source)}};
 verifyCareIntentCandidate(candidate.manifest,candidate.release,candidate.bundle,candidate.zip,applicationCurrent);
 const bundle=await buildCareIdentityBundle(root);
 check(bundle.equals(candidate.bundle),'rebuilt_bundle');
 check(canonical(careIntentCurrent(root,mobileRoot))===canonical(operatorCurrent),'checkout_changed');
 return {contract:'synthetic-care-intent-resumption-source/1',applicationCurrent,operatorCurrent,runtime,sourceRepresentations,
  canonicalGitSources:{applicationDesktop:applicationDesktop.snapshot,applicationMobile:applicationMobile.snapshot,
   operatorDesktop:operatorDesktop.snapshot,operatorMobile:operatorMobile.snapshot},
  bundleSha256:sha256(bundle),zipSha256:candidate.manifest.zipSha256,historicalSourcesVerified:true,
  currentRuntimeByteMatched:true,awsObserved:false,custodyAcquired:false,deployed:false,schemaChanged:false,
  hostedAcceptance:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
}
