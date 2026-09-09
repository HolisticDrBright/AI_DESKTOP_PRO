import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {createOwnedConsumerRecordsAdapter,OwnedStorageError,type OwnedRecord,type OwnedStorageScope} from './owned-consumer-records';

/** Initial personal context contract. Does not manufacture lab observations,
 * diagnosed patterns, demographics, clinician approval, or recovery scores. */
export async function buildOwnedChatContext(adapter:ReturnType<typeof createOwnedConsumerRecordsAdapter>,context:ProductionClinicalRequestContext,allowed:readonly OwnedStorageScope[],now=Date.now()){
  const consentContext={...context,purpose:'consent_management' as const};
  const ai=await adapter.consentState(consentContext,'ai_context');
  if(!ai.activeRevision)throw new OwnedStorageError('consent_required');
  const contextData={...context,purpose:'clinical_data' as const};
  let profile:Record<string,unknown>|null=null;
  let formsRevision:number|null=null;
  const used=new Map<OwnedStorageScope,number>();
  let cycle:Record<string,unknown>|null=null;let wearables:Record<string,unknown>|null=null;
  let recentReports:Record<string,unknown>[]=[];
  let labs:Record<string,unknown>[]=[];
  if(allowed.includes('lab_history')){
    const consent=await adapter.consentState(consentContext,'lab_history');
    if(consent.activeRevision){
      used.set('lab_history',consent.activeRevision);
      // Page through the owned history, not just the first 100 observations.
      // Refuse oversized context instead of silently asserting missing markers.
      const rows:OwnedRecord[]=[];
      let after:{receivedAt:string;recordId:string}|undefined;
      const seen=new Set<string>();
      for(;;){
        const page=await adapter.list(contextData,{collection:'lab_observations',limit:100,...(after?{after}:{})});
        for(const row of page){if(seen.has(row.recordId))throw new OwnedStorageError('storage_unavailable');seen.add(row.recordId);rows.push(row);}
        if(rows.length>1000)throw new OwnedStorageError('storage_unavailable');
        if(page.length<100)break;
        const last=page.at(-1)!;after={receivedAt:last.receivedAt,recordId:last.recordId};
      }
      labs=rows.map(row=>({name:row.payload.name,value:row.payload.value,unit:row.payload.unit,drawnAt:row.payload.drawnAt,
        // Preserve imported ranges in history, but do not promote unverified
        // ranges/statuses to the model's conventional or functional authority.
        conventionalRange:null,functionalRange:null,sourceStatus:'consumer_import_unverified'}))
        .sort((a,b)=>String(b.drawnAt).localeCompare(String(a.drawnAt))||String(a.name).localeCompare(String(b.name)));
    }
  }
  if(allowed.includes('forms_checkins')){
    const forms=await adapter.consentState(consentContext,'forms_checkins');formsRevision=forms.activeRevision;
    if(formsRevision){
      const [profiles,lifestyles,contraindications]=await Promise.all([
        adapter.recent(contextData,{collection:'wellness_profiles',limit:1}),
        adapter.recent(contextData,{collection:'lifestyle_profiles',limit:1}),
        adapter.recent(contextData,{collection:'contraindications',limit:1}),
      ]);
      const p=latest(profiles),l=latest(lifestyles),c=latest(contraindications);
      if(p||l||c)profile={ageYears:null,sex:null,goals:strings(p?.goals,30,160),contraindications:strings(c?.conditions,50,200),allergies:strings(c?.allergies,50,200),medications:strings(c?.medications,50,200),dietOfRecord:text(l?.dietType,160),cookingSkill:text(l?.cookingSkill,80)};
    }
  }
  if(allowed.includes('reproductive_health')){
    const consent=await adapter.consentState(consentContext,'reproductive_health');
    if(consent.activeRevision){
      used.set('reproductive_health',consent.activeRevision);
      const p=latest(await adapter.recent(contextData,{collection:'reproductive_profiles',limit:1}));
      const artifact=p?.consent && typeof p.consent==='object'?p.consent as Record<string,unknown>:null;
      if(p && ['regular_cycle','hormonal_contraception','irregular_cycle','perimenopause','pregnant','postpartum','menopause'].includes(String(p.stage)) && artifact?.status==='granted' && typeof artifact.artifactVersion==='string'){
        // A day number alone does not confirm ovulation or a biological phase.
        cycle={mode:p.stage,day:typeof p.cycleDay==='number'&&Number.isInteger(p.cycleDay)&&p.cycleDay>=1&&p.cycleDay<=60?p.cycleDay:null,phase:'unknown',confidence:'none',consentVersion:artifact.artifactVersion};
      }
    }
  }
  if(allowed.includes('wearables')){
    const consent=await adapter.consentState(consentContext,'wearables');
    if(consent.activeRevision){used.set('wearables',consent.activeRevision);wearables=measuredWearables(await adapter.recent(contextData,{collection:'wearable_daily_records',limit:50}),now);}
  }
  if(allowed.includes('symptoms_adherence')){
    const consent=await adapter.consentState(consentContext,'symptoms_adherence');
    if(consent.activeRevision){
      used.set('symptoms_adherence',consent.activeRevision);
      recentReports=reports(await adapter.recent(contextData,{collection:'adverse_event_reports',limit:20}),now);
    }
  }
  // Recheck the exact revisions after collection, so withdrawal/reconsent while
  // assembling does not release a snapshot authorized under an earlier grant.
  const finalAi=await adapter.consentState(consentContext,'ai_context');
  if(finalAi.activeRevision!==ai.activeRevision)throw new OwnedStorageError('consent_required');
  if(formsRevision && (await adapter.consentState(consentContext,'forms_checkins')).activeRevision!==formsRevision)throw new OwnedStorageError('consent_required');
  for(const [scope,revision]of used){if((await adapter.consentState(consentContext,scope)).activeRevision!==revision)throw new OwnedStorageError('consent_required');}
  return {profile,cycle,wearables,labs,protocol:null,tcm:null,conversationMemory:null,promotedPatterns:[],careTeam:null,recentReports,governedOptions:[]};
}
function reports(rows:OwnedRecord[],now:number):Record<string,unknown>[]{
  return rows.map(row=>{
    const p=row.payload;
    const onset=typeof p.onset_at==='string'?Date.parse(p.onset_at):NaN;
    if(!Number.isFinite(onset)||onset>now||now-onset>30*86400000)return null;
    const answers=p.safety_answers;
    if(!['new_symptom','possible_adverse_reaction'].includes(String(p.event_type))
      || typeof p.symptom!=='string'||p.symptom.length<2||p.symptom.length>200
      || typeof p.severity!=='number'||!Number.isInteger(p.severity)||p.severity<1||p.severity>10
      || !answers||typeof answers!=='object'||Array.isArray(answers))throw new OwnedStorageError('storage_unavailable');
    const safety=answers as Record<string,unknown>;
    const fields=['breathingDifficulty','faceOrThroatSwelling','chestPain','faintingOrSeizure','uncontrolledBleeding','immediateDanger'];
    if(fields.some(key=>typeof safety[key]!=='boolean'))throw new OwnedStorageError('storage_unavailable');
    return {eventType:p.event_type,symptom:p.symptom,severity:p.severity,onsetAt:new Date(onset).toISOString(),
      suspectedProductName:text(p.suspected_product_name,200),actionsTaken:strings(p.actions_taken,20,120),notes:text(p.notes,2000),
      urgentSafetyAnswer:fields.some(key=>safety[key]===true)};
  }).filter((row):row is NonNullable<typeof row>=>row!==null).sort((a,b)=>b.onsetAt.localeCompare(a.onsetAt));
}
function measuredWearables(rows:OwnedRecord[],now:number):Record<string,unknown>|null{
  const days=new Map<string,Record<string,unknown>>();
  for(const row of [...rows].sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt))){const p=row.payload;const d=p.date;if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||Date.parse(d)>now)continue;if(!days.has(d))days.set(d,p);}
  const dates=[...days.keys()].sort().reverse();const day=dates[0];if(!day||now-Date.parse(day)>3*86400000)return null;
  const p=days.get(day)!;const baseline=dates.filter(d=>d<day&&Date.parse(day)-Date.parse(d)<=14*86400000).map(d=>days.get(d)!);
  const number=(v:unknown,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
  const delta=(field:string,max:number)=>{const current=number(p[field],max);const values=baseline.map(b=>number(b[field],max)).filter((v):v is number=>v!==null);if(current===null||values.length<5)return null;const avg=values.reduce((sum,v)=>sum+v,0)/values.length;if(avg<=0)return null;const change=(current-avg)/avg*100;return Math.abs(change)<=500?Math.round(change*100)/100:null;};
  const steps=number(p.steps,200000);const sleep=number(p.sleepDurationMinutes,1440);const hrv=delta('hrv',500);const rhr=delta('restingHr',250);
  if(steps===null&&sleep===null&&hrv===null&&rhr===null)return null;
  return {date:day,baselineDays:14,steps,sleepMinutes:sleep,hrvDeltaPercent:hrv,restingHeartRateDeltaPercent:rhr,sleepDeltaPercent:delta('sleepDurationMinutes',1440),recoveryScore:null};
}
function latest(rows:OwnedRecord[]){return [...rows].sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)||b.recordId.localeCompare(a.recordId))[0]?.payload??null;}
function strings(value:unknown,max:number,length:number):string[]{if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||v.length>length))throw new OwnedStorageError('storage_unavailable');return value as string[];}
function text(value:unknown,max:number):string|null{if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||value.length>max)throw new OwnedStorageError('storage_unavailable');return value;}
