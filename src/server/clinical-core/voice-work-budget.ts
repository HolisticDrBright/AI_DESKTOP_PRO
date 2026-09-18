/** One invocation's deadline. Reserve time to release a lease; never reuse this
 * object across warm Lambda invocations. Remote timeouts are uncertain, not
 * proof that a provider write did not happen. Durable work remains retryable. */
export class VoiceWorkDeferred extends Error {
  constructor(){super('voice_work_deferred');}
}
export type VoiceWorkBudget={canStart:()=>boolean;signal:(release?:boolean)=>AbortSignal;check:()=>void};
export function createVoiceWorkBudget(remaining:()=>number=()=>30000,clock:()=>number=Date.now):VoiceWorkBudget{
  const started=clock(),initial=remaining();
  if(!Number.isFinite(initial)||initial<0)throw new VoiceWorkDeferred();
  const deadline=started+Math.min(initial,30000);
  const left=()=>{
    const reported=remaining();
    if(!Number.isFinite(reported)||reported<0)return 0;
    return Math.min(reported,deadline-clock());
  };
  const check=()=>{if(left()<=5000)throw new VoiceWorkDeferred();};
  return {canStart:()=>left()>12000,check,signal:(release=false)=>{
    const available=Math.floor(left()-(release?1000:5000));
    if(available<=0)throw new VoiceWorkDeferred();
    return AbortSignal.timeout(Math.min(15000,available));
  }};
}
export type VoiceInvocationContext={getRemainingTimeInMillis:()=>number};
