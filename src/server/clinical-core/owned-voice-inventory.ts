import {createHash} from 'node:crypto';

export type VoiceInventoryInput={
  jobs:unknown[];
  versions:unknown[];
  deleteMarkers:unknown[];
  providerJobs:unknown[];
};
const id=/^[a-f0-9]{64}$/;
const bad=()=>new Error('voice_inventory_invalid_or_incomplete');
const object=(v:unknown):Record<string,unknown>=>{
  if(!v||typeof v!=='object'||Array.isArray(v))throw bad();
  return v as Record<string,unknown>;
};
const text=(v:unknown,max=1024)=>{
  if(typeof v!=='string'||!v||v.length>max)throw bad();
  return v;
};
// Counts/fingerprints only leave this module. No owners, consent proofs,
// transcripts, object keys, provider URIs or job IDs appear in the report.
export function summarizeVoiceInventory(input:VoiceInventoryInput){
  for(const values of Object.values(input))if(!Array.isArray(values)||values.length>100_000)throw bad();
  const jobs=new Map<string,string>(),artifacts=new Set<string>(),seenVersions=new Set<string>(),providers=new Set<string>();
  const canonical:string[]=[];
  let uncleanJobs=0,cleanedStillPending=0,orphanObjectVersions=0,orphanProviderJobs=0,cleanedJobsWithArtifacts=0;
  for(const value of input.jobs){
    const row=object(value),jobId=text(row.id,64),state=text(row.state,16);
    if(!id.test(jobId)||jobs.has(jobId)||!['uploading','queued','running','ready','failed','cleaned'].includes(state)
      ||!(row.pending===undefined||row.pending==='work'))throw bad();
    jobs.set(jobId,state);
    if(state!=='cleaned')uncleanJobs++;
    else if(row.pending!==undefined)cleanedStillPending++;
    canonical.push(JSON.stringify(['job',jobId,state,row.pending??null]));
  }
  for(const [kind,values] of [['version',input.versions],['delete-marker',input.deleteMarkers]] as const){
    for(const value of values){
      const row=object(value),key=text(row.Key),version=text(row.VersionId);
      const match=key.match(/^personal-voice\/(?:input\/([a-f0-9]{64})\.(?:mp4|wav)|output\/([a-f0-9]{64})\.json)$/);
      if(!match)throw bad();
      const jobId=match[1]??match[2],unique=JSON.stringify([key,version]);
      if(seenVersions.has(unique))throw bad();
      seenVersions.add(unique);artifacts.add(jobId);
      if(!jobs.has(jobId))orphanObjectVersions++;
      canonical.push(JSON.stringify([kind,key,version]));
    }
  }
  for(const value of input.providerJobs){
    const row=object(value),name=text(row.TranscriptionJobName),status=text(row.TranscriptionJobStatus,16);
    const match=name.match(/^alp-personal-voice-([a-f0-9]{64})$/);
    if(!match||providers.has(name)||!['QUEUED','IN_PROGRESS','COMPLETED','FAILED'].includes(status))throw bad();
    providers.add(name);artifacts.add(match[1]);
    if(!jobs.has(match[1]))orphanProviderJobs++;
    canonical.push(JSON.stringify(['provider',name,status]));
  }
  for(const jobId of artifacts)if(jobs.get(jobId)==='cleaned')cleanedJobsWithArtifacts++;
  return {
    version:'owned-voice-inventory/1',
    atomicSnapshot:false,
    deletionCertified:false,
    candidateClear:uncleanJobs===0&&cleanedStillPending===0&&seenVersions.size===0&&providers.size===0,
    counts:{jobMetadata:jobs.size,uncleanJobs,cleanedStillPending,objectVersions:input.versions.length,
      deleteMarkers:input.deleteMarkers.length,providerJobs:providers.size,orphanObjectVersions,orphanProviderJobs,cleanedJobsWithArtifacts},
    fingerprint:createHash('sha256').update(canonical.sort().join('\n')).digest('hex'),
    excluded:['backups','PITR','audit logs','other buckets/prefixes','other accounts/regions','identity and account data'],
  };
}
