import {describe,expect,it} from 'vitest';
import {birthDateBoundsForCompletedAge} from './lab-recorded-age';
import {matchPreciseLabRanges,collectionRangeContextSchema,type PreciseLabRangeRelease} from './lab-range-population';
import {resolveReviewedLabRange} from './lab-range-release';
import {safeStructuredLabBiomarkers} from './aws-lab-analysis-api';
import {normalizeStructuredLabBiomarkers} from './aws-lab-analysis-worker';

const now=Date.parse('2026-09-16T12:00:00Z');
const context={ageAtDraw:{value:35,unit:'years' as const},observedOn:'2026-01-01',sex:'female' as const,
  pregnancyStatus:'not_pregnant' as const,cyclePhase:null,reproductiveStage:null,contraception:null,pregnancyTrimester:null,assayId:'fictional'};
const release=(age:PreciseLabRangeRelease['ranges'][number]['population']['age']):PreciseLabRangeRelease=>({
  schemaVersion:'lab-ranges/2',version:'fictional/2',expiresAt:'2027-01-01T00:00:00Z',ranges:[{
    id:'11111111-1111-4111-8111-111111111111',canonicalName:'Fictional',aliases:[],unit:'widgets/L',rangeKind:'functional_target',min:10,max:20,
    population:{label:'Fictional age range',age,sexes:['female'],pregnancyStatuses:['not_pregnant'],cyclePhases:null,reproductiveStages:null,contraceptions:null,pregnancyTrimesters:null,assayIds:['fictional']},
    source:{id:'22222222-2222-4222-8222-222222222222',version:'fixture/1',url:'https://example.invalid/fixture',packageSha256:'a'.repeat(64),recordId:'fictional',recordSha256:'b'.repeat(64),verification:'V',verifiedBy:'Fixture',verifiedOn:'2026-01-01',verifiedAgainst:'Fictional only'},
    reviewedBy:'Fixture',reviewedAt:'2026-01-01T00:00:00Z',
  }],
});
const age=(unit:'days'|'months'|'years',min:number,max:number)=>({unit,min,max,minInclusive:true,maxInclusive:false});
describe('stored completed-age precision',()=>{
  it('retains the entire possible birth interval, not an invented birthday',()=>{
    expect(birthDateBoundsForCompletedAge({value:35,unit:'years'},'2026-01-01')).toEqual(['1990-01-02','1991-01-01']);
    expect(birthDateBoundsForCompletedAge({value:2,unit:'months'},'2026-03-31')).toEqual(['2026-01-01','2026-01-31']);
    expect(birthDateBoundsForCompletedAge({value:13,unit:'days'},'2026-01-14')).toEqual(['2026-01-01','2026-01-01']);
    expect(birthDateBoundsForCompletedAge({value:1,unit:'months'},'2025-02-28')).toEqual(['2024-12-29','2025-01-28']);
  });
  it('matches only ranges covering the whole recorded age interval, including cross-unit bands',()=>{
    expect(matchPreciseLabRanges(release(age('years',35,36)),'Fictional','widgets/L',context,'functional_target',now)).toHaveLength(1);
    expect(matchPreciseLabRanges(release(age('months',420,432)),'Fictional','widgets/L',context,'functional_target',now)).toHaveLength(1);
    expect(matchPreciseLabRanges(release(age('months',420,421)),'Fictional','widgets/L',context,'functional_target',now)).toEqual([]);
    const inclusive=release({...age('years',34,35),maxInclusive:true});
    expect(matchPreciseLabRanges(inclusive,'Fictional','widgets/L',context,'functional_target',now)).toEqual([]);
  });
  it('does not silently equate completed-age and clamped anniversary conventions on leap dates',()=>{
    const c={...context,observedOn:'2025-02-28',ageAtDraw:{value:0,unit:'years'}};
    // Feb29 births may have completed age0 by the old storage convention but
    // meet a one-year clamped range boundary today. The coarse context is ambiguous.
    expect(matchPreciseLabRanges(release(age('years',0,1)),'Fictional','widgets/L',c,'functional_target',now)).toEqual([]);
    expect(matchPreciseLabRanges(release(age('years',0,2)),'Fictional','widgets/L',c,'functional_target',now)).toHaveLength(1);
  });
  it('preserves exact-day pediatric boundaries without using current adult demographics',()=>{
    const c={...context,observedOn:'2026-01-14',ageAtDraw:{value:13,unit:'days'}};
    expect(matchPreciseLabRanges(release(age('days',4,15)),'Fictional','widgets/L',c,'functional_target',now)).toHaveLength(1);
    expect(matchPreciseLabRanges(release(age('days',4,13)),'Fictional','widgets/L',c,'functional_target',now)).toEqual([]);
    const catalog={release:release(age('days',4,15)),sha256:'c'.repeat(64)};
    const rows=safeStructuredLabBiomarkers([{markerId:'fixture',canonicalName:'Fictional',value:25,unit:'widgets/L',labMin:null,labMax:null,collectionContext:c}]);
    expect(normalizeStructuredLabBiomarkers(rows,'fictional-document','',{catalog,population:{ageYears:75,sex:'male',pregnancyStatus:'not_applicable'}})[0].functionalMin).toBe(10);
  });
  it('retains missing-dimension, ambiguity, source-type and expiry safeguards',()=>{
    const r=release(age('years',18,65)),population={ageYears:35,sex:'female',pregnancyStatus:'not_pregnant',collection:context};
    const catalog={release:r,sha256:'c'.repeat(64)};
    expect(resolveReviewedLabRange(catalog,'Fictional','widgets/L',population,now).rangeReview).toBe('matched');
    expect(resolveReviewedLabRange(catalog,'Fictional','widgets/L',{...population,collection:{...context,assayId:null}},now).functionalMin).toBeNull();
    r.ranges.push({...r.ranges[0],id:'33333333-3333-4333-8333-333333333333'});
    expect(resolveReviewedLabRange(catalog,'Fictional','widgets/L',population,now).rangeReview).toBe('ambiguous_reviewed_range');
    expect(()=>resolveReviewedLabRange(catalog,'Fictional','widgets/L',population,Date.parse('2028-01-01'))).toThrow('lab_range_release_refused');
    for(const row of r.ranges)row.rangeKind='conventional_reference';
    expect(matchPreciseLabRanges(r,'Fictional','widgets/L',context,'functional_target',now)).toEqual([]);
  });
  it.each([
    {...context,dateOfBirth:'1990-01-01'},
    {...context,ageAtDraw:{value:35.5,unit:'years'}},
    {...context,ageAtDraw:{value:-1,unit:'days'}},
    {...context,ageAtDraw:{value:126,unit:'years'}},
    {...context,ageAtDraw:{value:35,unit:'decades'}},
    {...context,observedOn:'2026-02-30'},
    {...context,pregnancyTrimester:1},
  ])('refuses conflicting or malformed age context %#',c=>{
    expect(collectionRangeContextSchema.safeParse(c).success).toBe(false);
    expect(()=>safeStructuredLabBiomarkers([{markerId:'f',canonicalName:'Fictional',value:1,unit:'widgets/L',labMin:null,labMax:null,collectionContext:c}])).toThrow();
  });
  it('bounded binary-search endpoints equal exhaustive completed-age membership around month ends',()=>{
    const dates=['2024-02-29','2025-02-28','2026-01-31','2026-03-01','2026-03-31'];
    for(const observed of dates)for(const unit of ['days','months','years'] as const)for(const value of [0,1,2,35]){
      const bounds=birthDateBoundsForCompletedAge({unit,value},observed)!;
      expect(bounds).not.toBeNull();
      const [start,end]=bounds.map(Date.parse),o=new Date(observed);
      const completed=(time:number)=>{
        const b=new Date(time),months=(o.getUTCFullYear()-b.getUTCFullYear())*12+o.getUTCMonth()-b.getUTCMonth()-(o.getUTCDate()<b.getUTCDate()?1:0);
        return unit==='days'?(o.getTime()-time)/86400000:unit==='months'?months:Math.floor(months/12);
      };
      expect(completed(start-86400000)).toBeGreaterThan(value);
      for(let time=start;time<=end;time+=86400000)expect(completed(time)).toBe(value);
      if(end<o.getTime())expect(completed(end+86400000)).toBeLessThan(value);
    }
  });
});
