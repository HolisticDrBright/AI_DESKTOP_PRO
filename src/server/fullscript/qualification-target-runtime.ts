if(typeof window!=='undefined')throw Error('Fullscript target runtime is server-only.');
import {createNativeFullscriptQualificationApi} from './qualification-observer';
import {FULLSCRIPT_QUALIFICATION_ROUTES,type FullscriptQualificationEvent,type FullscriptLambdaContext} from './qualification-api';
import {loadFullscriptQualificationTarget,nativeFullscriptTargetStore,type FullscriptTargetBuild} from './qualification-target-loader';

/** Source-only runtime composition, not an installed route. Native construction
 * uses only the stored immutable target and live observer; no provider/target
 * dependency can be supplied by an incoming event. There is no fallback. */
export function createNativeFullscriptTargetRuntime(build:FullscriptTargetBuild){
 return async(event:FullscriptQualificationEvent,context:FullscriptLambdaContext)=>{
  const reply=(statusCode:number,error:string)=>({statusCode,headers:{'content-type':'application/json','cache-control':'no-store',
   'x-content-type-options':'nosniff'},body:JSON.stringify({error,phiAllowed:false})});
  if(event.routeKey!==FULLSCRIPT_QUALIFICATION_ROUTES.workforce&&event.routeKey!==FULLSCRIPT_QUALIFICATION_ROUTES.consumer)
   return reply(404,'route_not_found');
  try{
   const target=await loadFullscriptQualificationTarget({env:process.env,build,context,store:nativeFullscriptTargetStore()});
   return await createNativeFullscriptQualificationApi(target)(event,context);
  }catch{return reply(503,'fullscript_delivery_refused');}
 };
}
