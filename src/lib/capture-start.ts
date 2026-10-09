/** Browser capture preparation: no recording begins until server authorization.
 * A timed-out mutation may have committed; callers must reconcile, never retry it
 * automatically. Late microphone permission must not leave a live device behind.
 */
export class CapturePreparationError extends Error {
  constructor(readonly code:'microphone_denied'|'microphone_timeout'|'authorization_unconfirmed'|'cancelled') {super(code);}
}
export async function prepareCapture<T>(options:{
  signal:AbortSignal;
  microphone:()=>Promise<MediaStream>;
  authorize:(signal:AbortSignal)=>Promise<T>;
}):Promise<{stream:MediaStream;authorization:T}>{
  if(options.signal.aborted)throw new CapturePreparationError('cancelled');
  let stream:MediaStream|null=null;
  let ownsStream=true;
  const stop=(value:MediaStream)=>value.getTracks().forEach(track=>track.stop());
  try{
    const microphone=options.microphone().then(value=>{
      if(!ownsStream||options.signal.aborted){stop(value);throw new CapturePreparationError('cancelled');}
      stream=value;return value;
    }).catch(error=>{throw error instanceof CapturePreparationError?error:new CapturePreparationError('microphone_denied');});
    await within(microphone,options.signal,30000,'microphone_timeout');
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    options.signal.addEventListener('abort',cancel,{once:true});
    try{
      const authorization=await within(options.authorize(controller.signal),options.signal,8000,'authorization_unconfirmed');
      if(options.signal.aborted)throw new CapturePreparationError('cancelled');
      ownsStream=false;
      return {stream:stream!,authorization};
    }finally{options.signal.removeEventListener('abort',cancel);controller.abort();}
  }finally{if(ownsStream&&stream)stop(stream);ownsStream=false;}
}
function within<T>(work:Promise<T>,signal:AbortSignal,ms:number,timeout:'microphone_timeout'|'authorization_unconfirmed'):Promise<T>{
  return new Promise((resolve,reject)=>{
    const cancel=()=>finish(()=>reject(new CapturePreparationError('cancelled')));
    const timer=setTimeout(()=>finish(()=>reject(new CapturePreparationError(timeout))),ms);
    let settled=false;
    function finish(action:()=>void){if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);action();}
    signal.addEventListener('abort',cancel,{once:true});
    if(signal.aborted)cancel();
    work.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));
  });
}
