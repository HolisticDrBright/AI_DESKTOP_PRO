import {FullscriptUpgradeError} from './fullscript-schema-upgrade';

/** This is preparation, not a settlement receipt. The native local-only closure
 * may retire custody only after the original outer DB fence returned exactly
 * the callback's value. It must perform no DB operation after fence exit. */
export type SchemaUpgradeSettlement={runId:string;journalSha256:string;retire():Promise<void>};
type Prepared<T>={value:T;settlement:SchemaUpgradeSettlement};
export async function finishSchemaUpgradeFence<F,P extends Prepared<object>>(
  withFence:<R>(work:(fence:F)=>Promise<R>)=>Promise<R>,
  work:(fence:F)=>Promise<P>,
):Promise<P['value']&{runId:string;journalSha256:string;custodySettled:true}> {
  let calls=0,accepting=true,sealed:Prepared<P['value']>|undefined;
  let sealedBytes:string|undefined,retire:(()=>Promise<void>)|undefined;
  let returned:Prepared<P['value']>;
  try{
    returned=await withFence(async fence=>{
      if(!accepting||++calls!==1)throw new FullscriptUpgradeError('custody_refused','fence_callback');
      const prepared=await work(fence),s=prepared.settlement;
      if(!s||Object.keys(s).sort().join(',')!=='journalSha256,retire,runId'
        || !/^[a-f0-9]{32}$/.test(s.runId)||!/^[a-f0-9]{64}$/.test(s.journalSha256)||typeof s.retire!=='function')
        throw new FullscriptUpgradeError('custody_refused','settlement_preparation');
      // Freeze the public identity independently of any port retaining s.
      sealed={value:structuredClone(prepared.value),settlement:{runId:s.runId,journalSha256:s.journalSha256,retire:s.retire.bind(s)}};
      sealedBytes=JSON.stringify(sealed);retire=sealed.settlement.retire;
      return sealed;
    });
  }catch(error){
    if(sealed)throw new FullscriptUpgradeError('custody_refused','outer_fence_exit');
    throw error;
  }finally{accepting=false;}
  if(calls!==1||!sealed||returned!==sealed||JSON.stringify(returned)!==sealedBytes||sealed.settlement.retire!==retire)
    throw new FullscriptUpgradeError('custody_refused','fence_result');
  try{await retire!();}
  catch{throw new FullscriptUpgradeError('custody_refused','local_retirement');}
  return {...sealed.value,runId:sealed.settlement.runId,journalSha256:sealed.settlement.journalSha256,custodySettled:true};
}
