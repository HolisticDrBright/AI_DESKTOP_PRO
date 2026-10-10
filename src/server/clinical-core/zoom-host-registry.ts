if (typeof window !== 'undefined') throw Error('zoom-host-registry is server-only');
import { createHash } from 'node:crypto';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';

/** Unreleased database port, not an authenticated HTTP handler, provider
 * activation or credential permission. Compiled pins must come from the exact
 * source artifact, never be learned from the database answering the request. */
export type ZoomHostFunctionPin = Readonly<{ name: string; bodySha256: string }>;
export type ZoomHostRegistryTarget=Readonly<{runtimeMode:'qualification'|'production';awsAccountId:string;region:'us-east-2'}>;
export class ZoomHostRegistryError extends Error {
  constructor(readonly category: 'request_invalid'|'identity_refused'|'conflict'|'service_unavailable') {
    super(category); this.name='ZoomHostRegistryError';
  }
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const prefix='clinical_telehealth.';
// Exact candidate and its directly called context/immutability dependencies.
const specs=[
  [prefix+'valid_host_configuration','(jsonb)','boolean','plpgsql','i',false,false],
  [prefix+'active_workforce','(uuid,uuid,text[])','boolean','sql','s',true,false],
  [prefix+'guard_host_release','()','trigger','plpgsql','v',true,false],
  [prefix+'guard_host_revocation','()','trigger','plpgsql','v',true,false],
  [prefix+'audit_host_release','()','trigger','plpgsql','v',true,false],
  [prefix+'require_actor','()','uuid','plpgsql','s',true,false],
  [prefix+'current_host_release','(uuid,uuid)','clinical_telehealth.zoom_host_releases','plpgsql','v',true,false],
  [prefix+'binding_metadata','(clinical_telehealth.zoom_visit_host_bindings,clinical_telehealth.zoom_host_releases)','jsonb','sql','i',false,false],
  [prefix+'bind_visit_host','(uuid,uuid)','jsonb','plpgsql','v',true,true],
  [prefix+'read_visit_host_binding','(uuid,text)','jsonb','plpgsql','v',true,true],
  ['clinical_private.claim','(text)','text','sql','s',false,null],
  ['clinical_private.actor_person_id','()','uuid','sql','s',false,null],
  ['clinical_private.organization_id','()','uuid','sql','s',false,null],
  ['clinical_private.set_request_context','(uuid,uuid,text,text,text,text,text)','void','plpgsql','v',true,true],
  ['clinical_private.block_update_delete','()','trigger','plpgsql','v',false,null],
] as const;

export function bindZoomHostRegistryDatabase(database: ClinicalCoreDatabase, supplied: readonly ZoomHostFunctionPin[]): ClinicalCoreDatabase {
  if (!Array.isArray(supplied) || supplied.length!==specs.length || new Set(supplied.map(f=>f.name)).size!==specs.length
    || supplied.some(f=>!specs.some(s=>s[0]===f.name)||!SHA.test(f.bodySha256)||f.bodySha256==='0'.repeat(64)))
    throw new ZoomHostRegistryError('service_unavailable');
  const expected=JSON.stringify(specs.map(([qualified,args,result,language,volatility,definer,callable])=>({
    schema:qualified.split('.')[0],name:qualified.split('.')[1],signature:qualified+args,result,language,volatility,definer,callable,
    sha256:supplied.find(f=>f.name===qualified)!.bodySha256,
  })));
  return { transaction:work=>database.transaction(async tx=>{
    const result=await tx.query<{valid:boolean}>(`with expected as (
      select * from jsonb_to_recordset($1::jsonb) e(schema text,name text,signature text,result text,language text,
        volatility text,definer boolean,callable boolean,sha256 text)
    ), functions as (
      select count(*)=15 and bool_and(p.oid=to_regprocedure(e.signature) and p.prorettype=e.result::regtype
        and p.prokind='f' and p.provolatile::text=e.volatility and p.prosecdef=e.definer
        and p.prolang=(select oid from pg_language where lanname=e.language)
        and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.sha256
        and (e.callable is null or has_function_privilege('clinical_core_api',p.oid,'EXECUTE')=e.callable)
        and (e.schema<>'clinical_telehealth' or not exists(
          select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))) valid
      from expected e join pg_namespace n on n.nspname=e.schema join pg_proc p on p.pronamespace=n.oid and p.proname=e.name
    ), tables as (
      select count(*)=4 and bool_and(c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity
        and not has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        and not has_any_column_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
        and not exists(select 1 from pg_policy where polrelid=c.oid)
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0)
        and not exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) p where a.attrelid=c.oid and p.grantee=0)) valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='clinical_telehealth' and c.relkind in ('r','p','v','m','f')
    ), trigger_specs(table_name,trigger_name,function_name,mask) as (values
      ('zoom_host_releases','zoom_host_release_guard','clinical_telehealth.guard_host_release()',31),
      ('zoom_host_revocations','zoom_host_revocation_guard','clinical_telehealth.guard_host_revocation()',31),
      ('zoom_host_releases','audit_zoom_host_release','clinical_telehealth.audit_host_release()',5),
      ('zoom_host_revocations','audit_zoom_host_revocation','clinical_telehealth.audit_host_release()',5),
      ('zoom_visit_host_bindings','zoom_visit_host_binding_immutable','clinical_private.block_update_delete()',27),
      ('host_authority_events','zoom_host_authority_event_immutable','clinical_private.block_update_delete()',27)
    ), triggers as (
      select count(*)=6 and bool_and(not t.tgisinternal and t.tgenabled='O' and t.tgtype=e.mask
        and t.tgfoid=to_regprocedure(e.function_name)) valid from trigger_specs e
      join pg_trigger t on t.tgname=e.trigger_name and t.tgrelid=('clinical_telehealth.'||e.table_name)::regclass
    ) select current_user='clinical_core_api' and not r.rolsuper and not r.rolbypassrls and not r.rolcanlogin
      and not has_schema_privilege('clinical_core_api','clinical_telehealth','CREATE')
      and (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clinical_telehealth')=10
      and f.valid and t.valid and g.valid as valid from functions f cross join tables t cross join triggers g
      cross join pg_roles r where r.rolname=current_user`,[expected]);
    if(result.rows.length!==1||result.rows[0].valid!==true) throw new ZoomHostRegistryError('service_unavailable');
    return work(tx);
  }) };
}

const configKeys=['runtimeMode','awsAccountId','region','zoomAccountId','zoomHostId','clientId','sdkAppKey','secretArn','secretVersionId',
  'providerReviewSha256','securityReviewSha256','sdkAuthorizationReviewSha256'] as const;
export type ZoomHostConfiguration=Readonly<Record<typeof configKeys[number],string>>;
export type ZoomHostBinding=Readonly<{
  bindingId:string; organizationId:string; appointmentId:string; patientRecordId:string; practitionerPersonId:string;
  appointmentVersion:number; scheduledStart:string; scheduledEnd:string; intentId:string; releaseId:string; releaseRevision:number;
  configurationSha256:string; configuration:ZoomHostConfiguration; providerActionAuthorized:false;
  purpose?:'new_processing'|'cleanup_metadata';
}>;
function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new ZoomHostRegistryError('service_unavailable');
  return value as Record<string,unknown>;
}
function exact(value:Record<string,unknown>,keys:readonly string[]) {
  if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k))) throw new ZoomHostRegistryError('service_unavailable');
}
function configuration(value:unknown):ZoomHostConfiguration {
  const c=record(value); exact(c,configKeys);
  if(configKeys.some(k=>typeof c[k]!=='string'||(c[k] as string).length<2||(c[k] as string).length>2048||/[\s\u0000-\u001f\u007f]/u.test(c[k] as string)
    ||Buffer.from(c[k] as string,'utf8').toString('utf8')!==c[k]))
    throw new ZoomHostRegistryError('service_unavailable');
  const v=c as Record<typeof configKeys[number],string>;
  if(!['qualification','production'].includes(v.runtimeMode)||v.region!=='us-east-2'
    ||v.awsAccountId!==(v.runtimeMode==='qualification'?'588966314750':'173535830222')
    ||['zoomAccountId','zoomHostId','clientId'].some(k=>! /^[A-Za-z0-9_-]{2,128}$/.test(v[k as keyof typeof v])||v[k as keyof typeof v].toLowerCase()==='me')
    ||v.sdkAppKey.length>500||! /^[A-Za-z0-9_-]{32,64}$/.test(v.secretVersionId)
    ||!new RegExp('^arn:aws:secretsmanager:us-east-2:'+v.awsAccountId+':secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$').test(v.secretArn)
    ||['providerReviewSha256','securityReviewSha256','sdkAuthorizationReviewSha256'].some(k=>!SHA.test(v[k as keyof typeof v])||v[k as keyof typeof v]==='0'.repeat(64)))
    throw new ZoomHostRegistryError('service_unavailable');
  return Object.freeze({...v});
}
/** This configuration has only known ASCII keys and bounded strings. PostgreSQL
 * jsonb text orders keys by byte length then bytes; preserve its exact hash,
 * not JSON.stringify's insertion order or a different canonicalization. */
function configurationDigest(c:ZoomHostConfiguration):string {
  const text='{'+Object.keys(c).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(k=>JSON.stringify(k)+': '+JSON.stringify(c[k as keyof typeof c])).join(', ')+'}';
  return createHash('sha256').update(text,'utf8').digest('hex');
}
/** Strict response parser, not an authorization grant. Only a current read
 * through the source-pinned registry can establish database authority. */
export function parseZoomHostBindingResponse(value:unknown,ctx:ProductionClinicalRequestContext,target:ZoomHostRegistryTarget,appointment:string,intent?:string,purpose?:'new_processing'|'cleanup_metadata'):ZoomHostBinding {
  const r=record(value);
  const keys=['bindingId','organizationId','appointmentId','patientRecordId','practitionerPersonId','appointmentVersion','scheduledStart','scheduledEnd',
    'intentId','releaseId','releaseRevision','configurationSha256','configuration','providerActionAuthorized'];
  exact(r,purpose?[...keys,'purpose']:keys);
  if(['bindingId','organizationId','appointmentId','patientRecordId','practitionerPersonId','intentId','releaseId'].some(k=>typeof r[k]!=='string'||!UUID.test(r[k] as string))
    ||r.organizationId!==ctx.organizationId||r.appointmentId!==appointment||(intent!==undefined&&r.intentId!==intent)
    ||((purpose===undefined||purpose==='new_processing')&&r.practitionerPersonId!==ctx.actorPersonId)
    ||r.providerActionAuthorized!==false||(purpose!==undefined&&r.purpose!==purpose)
    ||!Number.isSafeInteger(r.appointmentVersion)||(r.appointmentVersion as number)<1
    ||!Number.isSafeInteger(r.releaseRevision)||(r.releaseRevision as number)<1
    ||typeof r.scheduledStart!=='string'||typeof r.scheduledEnd!=='string'
    ||![r.scheduledStart,r.scheduledEnd].every(v=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))
    ||!Number.isFinite(Date.parse(r.scheduledStart))||!Number.isFinite(Date.parse(r.scheduledEnd))||Date.parse(r.scheduledEnd)<=Date.parse(r.scheduledStart)
    ||Date.parse(r.scheduledEnd)-Date.parse(r.scheduledStart)>8*60*60*1000
    ||typeof r.configurationSha256!=='string'||!SHA.test(r.configurationSha256)) throw new ZoomHostRegistryError('service_unavailable');
  const c=configuration(r.configuration);
  if(configurationDigest(c)!==r.configurationSha256||c.runtimeMode!==target.runtimeMode||c.awsAccountId!==target.awsAccountId||c.region!==target.region)
    throw new ZoomHostRegistryError('service_unavailable');
  return Object.freeze({...r,configuration:c}) as ZoomHostBinding;
}

export function createZoomHostRegistry(database:ClinicalCoreDatabase,compiledPins:readonly ZoomHostFunctionPin[],compiledTarget:ZoomHostRegistryTarget) {
  if(!compiledTarget||!['qualification','production'].includes(compiledTarget.runtimeMode)||compiledTarget.region!=='us-east-2'
    ||compiledTarget.awsAccountId!==(compiledTarget.runtimeMode==='qualification'?'588966314750':'173535830222'))
    throw new ZoomHostRegistryError('service_unavailable');
  const target=Object.freeze({...compiledTarget});
  const bound=bindZoomHostRegistryDatabase(database,compiledPins);
  return async(context:ProductionClinicalRequestContext,input:{action:'bind';appointmentId:string;intentId:string}|{action:'read';appointmentId:string;purpose:'new_processing'|'cleanup_metadata'}):Promise<ZoomHostBinding>=>{
    if(!context||context.identityPool!=='workforce'||context.purpose!=='clinical_data'||context.environment!=='production-clinical'
      ||context.dataClassification!=='clinical_phi'||context.productionBound!==true||context.realPatientData!==true||context.containsPhi!==true
      ||typeof context.actorPersonId!=='string'||!UUID.test(context.actorPersonId)||typeof context.organizationId!=='string'||!UUID.test(context.organizationId)
      ||typeof context.identitySubject!=='string'||! /^[A-Za-z0-9:_-]{8,128}$/.test(context.identitySubject))
      throw new ZoomHostRegistryError('identity_refused');
    if(!input||typeof input.appointmentId!=='string'||!UUID.test(input.appointmentId)||!['bind','read'].includes(input.action)
      ||(input.action==='bind'?(typeof input.intentId!=='string'||!UUID.test(input.intentId)):!['new_processing','cleanup_metadata'].includes(input.purpose))
      ||Object.keys(input).length!==3||!(input.action==='bind'?['action','appointmentId','intentId']:['action','appointmentId','purpose']).every(k=>Object.prototype.hasOwnProperty.call(input,k)))
      throw new ZoomHostRegistryError('request_invalid');
    try {
      return await bound.transaction(async tx=>{
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),
          context.identityPool,context.identitySubject,context.purpose,context.environment,context.dataClassification]);
        const result=await tx.query<{data:unknown}>(input.action==='bind'?'select clinical_telehealth.bind_visit_host($1,$2) as data':'select clinical_telehealth.read_visit_host_binding($1,$2) as data',
          [clinicalUuid(input.appointmentId),input.action==='bind'?clinicalUuid(input.intentId):input.purpose]);
        if(result.rows.length!==1) throw new ZoomHostRegistryError('service_unavailable');
        return parseZoomHostBindingResponse(result.rows[0].data,context,target,input.appointmentId,input.action==='bind'?input.intentId:undefined,input.action==='read'?input.purpose:undefined);
      });
    } catch(error) {
      if(error instanceof ZoomHostRegistryError) throw error;
      if(error instanceof ClinicalCoreDatabaseRejection) throw new ZoomHostRegistryError(error.category==='conflict'?'conflict':error.category==='request_invalid'?'request_invalid':error.category==='identity_refused'?'identity_refused':'service_unavailable');
      throw new ZoomHostRegistryError('service_unavailable');
    }
  };
}
