if(typeof window!=='undefined')throw Error('Fullscript target runtime is server-only.');
import {createNativeFullscriptQualificationApi,createSuccessorNativeFullscriptQualificationApi} from './qualification-observer';
import {FULLSCRIPT_QUALIFICATION_ROUTES,type FullscriptQualificationEvent,type FullscriptLambdaContext} from './qualification-api';
import {loadFullscriptQualificationTarget,loadSuccessorFullscriptQualificationTarget,assertSuccessorFullscriptEnvironment,
 nativeFullscriptTargetStore,type FullscriptTargetBuild} from './qualification-target-loader';
import {nativeFullscriptProviderEnvironmentLoader} from './qualification-provider-environment';
import type {SuccessorQualificationBuild} from '../clinical-core/successor-qualification-profile';

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
   const env={...process.env};
   const target=await loadFullscriptQualificationTarget({env,build,context,store:nativeFullscriptTargetStore()});
   return await createNativeFullscriptQualificationApi(target,nativeFullscriptProviderEnvironmentLoader(env))(event,context);
  }catch{return reply(503,'fullscript_delivery_refused');}
 };
}

/** Distinct compiled successor, drift-fenced before/after target reads and before
 * provider credential loading. Only per-invocation AWS tracing is excluded. */
export function createSuccessorNativeFullscriptTargetRuntime(supplied:SuccessorQualificationBuild){
 const build=structuredClone(supplied);
 const stable=()=>{const env={...process.env};delete env._X_AMZN_TRACE_ID;return env;};
 const captured=stable();
 const validate=()=>{
  const env=stable(),keys=Object.keys(env);
  if(keys.length!==Object.keys(captured).length||keys.some(key=>env[key]!==captured[key]))throw Error('fullscript_environment_changed');
  assertSuccessorFullscriptEnvironment(env,build);
  return env;
 };
 return async(event:FullscriptQualificationEvent,context:FullscriptLambdaContext)=>{
  const reply=(statusCode:number,error:string)=>({statusCode,headers:{'content-type':'application/json','cache-control':'no-store',
   'x-content-type-options':'nosniff'},body:JSON.stringify({error,phiAllowed:false})});
  if(event.routeKey!==FULLSCRIPT_QUALIFICATION_ROUTES.workforce&&event.routeKey!==FULLSCRIPT_QUALIFICATION_ROUTES.consumer)
   return reply(404,'route_not_found');
  try{
   const env=validate();
   const target=await loadSuccessorFullscriptQualificationTarget({env,build,context,store:nativeFullscriptTargetStore()});
   validate();
   const provider=nativeFullscriptProviderEnvironmentLoader(env);
   const providerEnvironment=async()=>{validate();const scoped=await provider();validate();return scoped;};
   const response=await createSuccessorNativeFullscriptQualificationApi(target,providerEnvironment)(event,context);
   validate();return response;
  }catch{return reply(503,'fullscript_delivery_refused');}
 };
}
