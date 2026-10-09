const DAY=86_400_000;
export type RecordedAge={value:number;unit:'days'|'months'|'years'};

/** Completed-month convention used by existing V2 stored copies: an anniversary
 * whose day does not exist in this month has not completed yet. This is NOT the
 * clamped interval-boundary convention used by reviewed range releases. */
function completedAge(birthDay:number,observedDay:number,unit:RecordedAge['unit']):number{
  if(unit==='days')return observedDay-birthDay;
  const birth=new Date(birthDay*DAY),observed=new Date(observedDay*DAY);
  const months=(observed.getUTCFullYear()-birth.getUTCFullYear())*12+
    observed.getUTCMonth()-birth.getUTCMonth()-(observed.getUTCDate()<birth.getUTCDate()?1:0);
  return unit==='months'?months:Math.floor(months/12);
}
/** Exact interval of possible birth calendar days for a completed recorded age.
 * Used transiently for matching; never persisted or represented as the DOB.
 * Two monotone binary searches avoid enumerating dates for every biomarker. */
export function birthDateBoundsForCompletedAge(age:RecordedAge,observedOn:string):[string,string]|null{
  const observed=Date.parse(observedOn);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(observedOn)||!Number.isFinite(observed)||
    new Date(observed).toISOString().slice(0,10)!==observedOn||!Number.isInteger(age.value)||age.value<0||
    !['days','months','years'].includes(age.unit)||age.value>({days:46000,months:1500,years:125})[age.unit])return null;
  const day=observed/DAY;
  const span=age.unit==='days'?age.value+1:age.unit==='months'?(age.value+2)*31:(age.value+2)*366;
  const floor=Math.max(Date.parse('0000-01-01')/DAY,day-span);
  const firstAtMost=(value:number)=>{
    let low=floor,high=day+1;
    while(low<high){
      const mid=Math.floor((low+high)/2);
      if(completedAge(mid,day,age.unit)<=value)high=mid;else low=mid+1;
    }
    return low;
  };
  const earliest=firstAtMost(age.value),latest=firstAtMost(age.value-1)-1;
  if(earliest>latest||earliest>day||completedAge(earliest,day,age.unit)!==age.value)return null;
  return [new Date(earliest*DAY).toISOString().slice(0,10),new Date(latest*DAY).toISOString().slice(0,10)];
}
