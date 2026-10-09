/** Aurora auto-pause cancels a request with this specific typed exception before executing it.
 * AWS recommends retrying after a short delay:
 * https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_BeginTransaction.html
 * Call only before a transaction starts or for a read-only administrative inspection.
 * Never retry a transaction body, commit, timeout, ambiguous network failure or access denial. */
export function isDatabaseResuming(error:unknown):boolean{
  return error!==null&&typeof error==='object'&&(error as {name?:unknown}).name==='DatabaseResumingException';
}
export async function retryDatabaseResume<T>(operation:()=>Promise<T>,sleep:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))):Promise<T>{
  const delays=[1_000,2_000,4_000];
  for(let attempt=0;;attempt++){
    try{return await operation();}catch(error){
      if(!isDatabaseResuming(error)||attempt>=delays.length)throw error;
      await sleep(delays[attempt]);
    }
  }
}
