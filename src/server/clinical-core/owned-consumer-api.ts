import {PERSONAL_DELETION_COVERAGE} from './owned-privacy-requests';
import type { ApiGatewayV2Event,ApiGatewayV2Response } from "./aws-identity-api";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
import { createOwnedConsumerRecordsAdapter,OwnedStorageError,OWNED_STORAGE_SCOPES,type OwnedStorageScope,type OwnedRecordWrite } from "./owned-consumer-records";
import { OWNED_COLLECTIONS as CONSUMER_CLINICAL_COLLECTIONS,type OwnedCollection as ConsumerClinicalCollection } from './owned-lab-observations';
import {buildOwnedChatContext} from './owned-chat-context';
import type {KnowledgeLoader} from './aws-reviewed-knowledge';

export type OwnedConsumerApiConfiguration = {
  consumerIssuer:string; consumerAudience:string;
  phiAllowed:boolean; activationState:"blocked"|"approved";
  activationEvidenceSha256?:string; allowedScopes:readonly OwnedStorageScope[];
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE="/clinical-core/consumer/personal";
export const OWNED_CONSUMER_ROUTES=[`GET ${BASE}/records`,`GET ${BASE}/record`,`POST ${BASE}/records`,`GET ${BASE}/consent`,`POST ${BASE}/consent`,`GET ${BASE}/chat-context`,`POST ${BASE}/privacy-export`,`GET ${BASE}/privacy-export`,`GET ${BASE}/active-plan`,`POST ${BASE}/active-plan`,`POST ${BASE}/active-plan/release`,`GET ${BASE}/privacy-request`,`POST ${BASE}/privacy-request`,`POST ${BASE}/privacy-request/tombstone`] as const;
const COLLECTION_SCOPE:Record<ConsumerClinicalCollection,OwnedStorageScope>={
  lab_observations:'lab_history',
  protocols:"protocols_supplements",daily_adherence:"symptoms_adherence",symptom_logs:"symptoms_adherence",
  hormone_entries:"reproductive_health",reproductive_profiles:"reproductive_health",meal_logs:"nutrition",
  subjective_rollups:"symptoms_adherence",weekly_checkins:"forms_checkins",wellness_profiles:"forms_checkins",
  lifestyle_profiles:"forms_checkins",contraindications:"forms_checkins",questionnaire_responses:"forms_checkins",
  clinical_intakes:"forms_checkins",wearable_daily_records:"wearables",adverse_event_reports:"symptoms_adherence",
};

/** API Gateway MUST verify the JWT signature. This adds exact consumer claims,
 * expiry, scope and activation checks; it never decodes an unverified header. */
export function createOwnedConsumerApi(input:{configuration:OwnedConsumerApiConfiguration;adapter:()=>ReturnType<typeof createOwnedConsumerRecordsAdapter>;now?:()=>number;knowledgeLoader?:KnowledgeLoader}) {
  const c=input.configuration;
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.consumerIssuer)
    || !/^[a-zA-Z0-9]{20,128}$/.test(c.consumerAudience)) throw new Error("owned_api_configuration_invalid");
  const active=c.phiAllowed===true && c.activationState==="approved" && /^[a-f0-9]{64}$/.test(c.activationEvidenceSha256??"")
    && c.allowedScopes.length>0 && c.allowedScopes.every(scope=>OWNED_STORAGE_SCOPES.includes(scope));
  if (c.phiAllowed && !active) throw new Error("owned_api_activation_invalid");
  return async(event:ApiGatewayV2Event):Promise<ApiGatewayV2Response>=>{
    if (!active) return response(503,{error:"production_not_activated",phiAllowed:false});
    try {
      const route=event.routeKey??"";
      if (!(OWNED_CONSUMER_ROUTES as readonly string[]).includes(route)) return response(404,{error:"route_not_found"});
      const consent=route.endsWith("/consent");
      const privacy=route.endsWith('/privacy-export')||route.includes('/privacy-request');
      const context=ownedConsumerIdentity(event,c,consent||privacy?"consent_management":"clinical_data",input.now?.()??Date.now());
      const post=route.startsWith("POST ");
      const q=event.queryStringParameters??{};
      if (post && Object.keys(q).length || !post && event.body) invalid();
      const body=post?parseBody(event):q;
      // Privacy access does not require clinic membership or re-granting a
      // withdrawn feature's consent. Identity + deployment gates still apply.
      if(privacy){
        const adapter=input.adapter();
        if(route.includes('/privacy-request')){
          // Deletion/correction requests and self-service tombstones need no
          // feature scope and survive withdrawal; they never claim full erasure.
          if(route.endsWith('/tombstone')){exact(body,['requestId','confirmTombstoneAllPersonalRecords']);return response(200,{data:await adapter.tombstonePersonalRecords(context,body as Parameters<typeof adapter.tombstonePersonalRecords>[1])});}
          if(post){exact(body,['requestId','kind','correction']);return response(200,{data:await adapter.submitPrivacyRequest(context,body as Parameters<typeof adapter.submitPrivacyRequest>[1])});}
          exact(body,[]);return response(200,{data:{requests:await adapter.listPrivacyRequests(context),coverage:PERSONAL_DELETION_COVERAGE}});
        }
        if(post){exact(body,['requestId']);return response(200,{data:await adapter.startPrivacyExport(context,{requestId:String(body.requestId??'')})});}
        exact(body,['exportId','section','limit','cursor']);
        return response(200,{data:await adapter.readPrivacyExport(context,{exportId:String(body.exportId??''),section:body.section as 'records'|'consents',
          limit:body.limit===undefined?25:Number(body.limit),...(body.cursor===undefined?{}:{cursor:body.cursor as string})})});
      }
      if(route.includes('/active-plan')){
        // The authoritative plan pointer is owner data under the plans scope; it
        // is never adopted by the server on its own and never reads plan content.
        if(!c.allowedScopes.includes('protocols_supplements'))return response(403,{error:'feature_scope_not_enabled'});
        const adapter=input.adapter();
        if(route.endsWith('/release')){exact(body,['requestId','expected']);return response(200,{data:await adapter.releaseActivePlan(context,body as Parameters<typeof adapter.releaseActivePlan>[1])});}
        if(post){exact(body,['recordId','revision','contentSha256','consentRevision','requestId','expectedPrevious']);return response(200,{data:await adapter.adoptActivePlan(context,body as Parameters<typeof adapter.adoptActivePlan>[1])});}
        exact(body,[]);return response(200,{data:await adapter.activePlan(context)});
      }
      if(route.endsWith('/chat-context')){
        exact(body,[]);
        if(!c.allowedScopes.includes('ai_context'))return response(403,{error:'feature_scope_not_enabled'});
        return response(200,{data:await buildOwnedChatContext(input.adapter(),context,c.allowedScopes,input.now?.()??Date.now(),input.knowledgeLoader)});
      }
      const scope=consent?body.scope:COLLECTION_SCOPE[body.collection as ConsumerClinicalCollection];
      if (!scope || !OWNED_STORAGE_SCOPES.includes(scope as OwnedStorageScope)) invalid();
      // Removing a feature from the release must not prevent consent history
      // access or withdrawal. New grants and clinical reads/writes stay blocked.
      const consentControl=consent && (!post || body.status==='revoked');
      if (!c.allowedScopes.includes(scope as OwnedStorageScope) && !consentControl) return response(403,{error:"feature_scope_not_enabled"});
      const adapter=input.adapter();
      if (consent) {
        if (post) {
          exact(body,["scope","status","releaseVersion","expectedRevision"]);
          const result=await adapter.setConsent(context,body as Parameters<typeof adapter.setConsent>[1]);
          return response(200,{data:result});
        }
        exact(body,["scope"]);
        return response(200,{data:await adapter.consentState(context,scope as OwnedStorageScope)});
      }
      const collection=body.collection as ConsumerClinicalCollection;
      if (!CONSUMER_CLINICAL_COLLECTIONS.includes(collection)) invalid();
      if (post) return response(200,{data:await adapter.write(context,body as OwnedRecordWrite)});
      if (route.endsWith("/record")) {
        exact(body,["collection","recordId"]);
        return response(200,{data:await adapter.get(context,{collection,recordId:String(body.recordId??"")})});
      }
      exact(body,["collection","limit","cursor"]);
      const limit=body.limit===undefined?100:Number(body.limit);
      const after=cursor(body.cursor);
      const items=await adapter.list(context,{collection,limit,...(after?{after}: {})});
      const last=items.length===limit?items.at(-1):undefined;
      return response(200,{data:{items,nextCursor:last?Buffer.from(JSON.stringify({receivedAt:last.receivedAt,recordId:last.recordId})).toString("base64url"):null}});
    } catch(error) {
      if (error instanceof OwnedStorageError) {
        const status=error.code==="request_invalid"?400:error.code==="owner_required"?401:error.code==="consent_required"?403:error.code==="conflict"?409:503;
        return response(status,{error:error.code==="owner_required"?"reauth_required":error.code});
      }
      return response(503,{error:"storage_unavailable"});
    }
  };
}
export function ownedConsumerIdentity(event:ApiGatewayV2Event,c:Pick<OwnedConsumerApiConfiguration,'consumerIssuer'|'consumerAudience'>,purpose:ProductionClinicalRequestContext["purpose"],now:number):ProductionClinicalRequestContext {
  const v=event.requestContext?.authorizer?.jwt?.claims??{};
  const sub=v.sub; const person=v["custom:person_id"]; const org=v["custom:organization_id"];
  if (v.iss!==c.consumerIssuer || v.aud!==c.consumerAudience || v.token_use!=="id"
    || ![true,"true"].includes(v.email_verified as boolean|string)
    || v["custom:production_bound"]!=="true" || [true,"true"].includes(v["custom:synthetic_attested"] as boolean|string)
    || typeof sub!=="string" || !/^[A-Za-z0-9:_-]{8,128}$/.test(sub)
    || typeof person!=="string" || !UUID.test(person) || typeof org!=="string" || !UUID.test(org)
    || !Number.isFinite(Number(v.exp)) || Number(v.exp)*1000<=now
    || !Number.isSafeInteger(Number(v.iat)) || Number(v.iat)<=0 || Number(v.iat)*1000>now+60_000
    || Number(v.iat)>=Number(v.exp)) throw new OwnedStorageError("owner_required");
  return {actorPersonId:person,organizationId:org,identitySubject:sub,identityPool:"consumer",purpose,
    environment:"production-clinical",dataClassification:"clinical_phi",containsPhi:true,realPatientData:true,productionBound:true};
}
function parseBody(event:ApiGatewayV2Event):Record<string,unknown> {
  const type=Object.entries(event.headers??{}).find(([key])=>key.toLowerCase()==="content-type")?.[1];
  if (!type?.toLowerCase().startsWith("application/json") || typeof event.body!=="string" || event.body.length>30_000) invalid();
  const raw=event.isBase64Encoded?Buffer.from(event.body,"base64"):Buffer.from(event.body,"utf8");
  if (raw.byteLength<1 || raw.byteLength>20_480) invalid();
  try { const value=JSON.parse(raw.toString("utf8")); if (!value || typeof value!=="object" || Array.isArray(value)) invalid(); return value; } catch { invalid(); }
}
function cursor(raw:unknown):{receivedAt:string;recordId:string}|undefined {
  if (raw===undefined) return undefined;
  if (typeof raw!=="string" || !/^[A-Za-z0-9_-]{20,240}$/.test(raw)) invalid();
  try { const value=JSON.parse(Buffer.from(raw,"base64url").toString()); exact(value,["receivedAt","recordId"]); if (typeof value.receivedAt!=="string" || value.receivedAt.length>40 || !Number.isFinite(Date.parse(value.receivedAt)) || typeof value.recordId!=="string" || !UUID.test(value.recordId)) invalid(); return value; } catch { invalid(); }
}
function exact(value:Record<string,unknown>,keys:string[]) { if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))) invalid(); }
function invalid():never { throw new OwnedStorageError("request_invalid"); }
function response(statusCode:number,payload:Record<string,unknown>):ApiGatewayV2Response { return {statusCode,headers:{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"},body:JSON.stringify(payload)}; }
