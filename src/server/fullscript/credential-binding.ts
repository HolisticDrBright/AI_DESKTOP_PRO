if (typeof window !== 'undefined') throw new Error('Fullscript credential binding is server-only.');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RequestSession} from '../session';
import {connectedFullscriptClient, fullscriptActor} from './runtime';
import {createAwsFullscriptTokenStore, parseStoredFullscriptConnection} from './token-store';
import type {StoredFullscriptConnection} from './token-store';
import {FULLSCRIPT_DRAFT_SCOPES} from './draft-scopes';
import {createFullscriptDraftProvider} from './draft-provider';
import {DraftDeliveryRefused, type DraftDeliveryProvider} from './draft-delivery';

const providerId=z.string().regex(/^[A-Za-z0-9-]{8,128}$/);
const hash=z.string().regex(/^[a-f0-9]{64}$/).refine(v=>v!=='0'.repeat(64));
const release=z.object({contract:z.literal('fullscript-sandbox-provider-release/1'),
  environment:z.literal('sandbox_us'),apiOrigin:z.literal('https://api-us-snd.fullscript.io/api'),
  clinicId:providerId,tokenBindingSha256:hash,
  scopes:z.array(z.enum(FULLSCRIPT_DRAFT_SCOPES)).length(FULLSCRIPT_DRAFT_SCOPES.length)
    .refine(v=>new Set(v).size===FULLSCRIPT_DRAFT_SCOPES.length),
}).strict();

// Documented clinic response includes clinic.id. Retain only this identity;
// name/counts/discount/dispensary URL are not authority; never follow URLs.
// https://fullscript.dev/technical-reference/clinic (checked 2026-10-09).
const clinicResponse=z.object({clinic:z.object({id:providerId}).passthrough()}).passthrough();
const guarded=async<T>(work:()=>Promise<T>):Promise<T>=>{
  try{return await work();}catch{throw new DraftDeliveryRefused();}
};
async function assertCredentialCustody(session:RequestSession,connection:StoredFullscriptConnection,env?:NodeJS.ProcessEnv){
  const store=createAwsFullscriptTokenStore(env);
  if(!store)throw new DraftDeliveryRefused();
  const actor=fullscriptActor(session),saved=await store.get(actor.actorKey,actor.organizationId);
  if(!saved||JSON.stringify(parseStoredFullscriptConnection(saved,actor))
    !==JSON.stringify(parseStoredFullscriptConnection(connection,actor)))throw new DraftDeliveryRefused();
}

/** Native observation, not review or target attestation. Hash one saved
 * installation, OAuth client, actor, clinic, owner and exact scope set. Exclude
 * rotating tokens/secrets; reconnect creates a new UUID at even the same time.
 * Legacy records need reauthorization, not an invented installation ID.
 * Practitioner-only until separate staff delegation is implemented/reviewed.
 */
async function observed(session:RequestSession,env?:NodeJS.ProcessEnv){
  const {client,connection}=await connectedFullscriptClient(session,true,env);
  if(connection.environment!=='sandbox_us'||!connection.installationId
    ||!connection.oauthClientId||!connection.oauthRedirectUri
    ||connection.resourceOwner.type!=='Practitioner')throw new DraftDeliveryRefused();
  client.assertSupplementDraftCapabilities();
  const configuration=client.sandboxInstallationConfiguration();
  if(connection.oauthClientId!==configuration.clientId||connection.oauthRedirectUri!==configuration.redirectUri)
    throw new DraftDeliveryRefused();
  const clinicId=clinicResponse.parse(await client.retrieveSandboxClinic()).clinic.id;
  const binding={contract:'fullscript-installation-binding/1',
    actorKey:connection.actorKey,organizationId:connection.organizationId,
    installationId:connection.installationId,connectedAt:connection.connectedAt,
    environment:connection.environment,apiOrigin:configuration.apiOrigin,
    clientId:configuration.clientId,redirectUri:configuration.redirectUri,
    clinicId,resourceOwner:connection.resourceOwner,scopes:[...connection.scope].sort()};
  const tokenBindingSha256=createHash('sha256').update(JSON.stringify(binding),'utf8').digest('hex');
  // Reconnect/disconnect/rotation during clinic I/O invalidates this observation.
  await assertCredentialCustody(session,connection,env);
  return {client,connection,observation:{contract:'fullscript-installation-observation/1' as const,
    environment:'sandbox_us' as const,apiOrigin:configuration.apiOrigin,clinicId,tokenBindingSha256,
    scopes:[...connection.scope].sort()}};
}

export function observeFullscriptDraftInstallation(session:RequestSession){
  return guarded(async()=> (await observed(session)).observation);
}

/** Source-only adapter: eventual handler MUST load this review from current
 * SAME-TARGET canonical authority, verify JWT/MFA/target/ledger and recheck
 * authority per admission. Arbitrary JSON is NOT approval. No route installs
 * this yet. Every operation reacquires credentials and observes clinic identity.
 * Production, staff delegation and patient-send are deliberately unavailable.
 */
export function createCredentialBoundFullscriptDraftProvider(session:RequestSession,rawRelease:unknown,
  beforeProviderRequest?:()=>Promise<void>,loadEnvironment?:()=>Promise<NodeJS.ProcessEnv>):DraftDeliveryProvider{
  const principal={...session};
  let reviewed:z.infer<typeof release>;
  try{reviewed=release.parse(rawRelease);}catch{throw new DraftDeliveryRefused();}
  const current=()=>guarded(async()=>{
    const env=loadEnvironment?await loadEnvironment():undefined;
    const result=await observed(principal,env),o=result.observation;
    if(o.environment!==reviewed.environment||o.apiOrigin!==reviewed.apiOrigin
      ||o.clinicId!==reviewed.clinicId||o.tokenBindingSha256!==reviewed.tokenBindingSha256)
      throw new DraftDeliveryRefused();
    return {...result,env};
  });
  return {
    create:input=>guarded(async()=>{
      const result=await current();
      if(input.practitionerId!==result.connection.resourceOwner.id)throw new DraftDeliveryRefused();
      // Credential observation performs I/O. Recheck same-target authority
      // after it, immediately before handing the admitted intent to transport.
      await beforeProviderRequest?.();
      await assertCredentialCustody(principal,result.connection,result.env);
      return createFullscriptDraftProvider(result.client).create(input);
    }),
    findByMetadata:key=>guarded(async()=>{
      const result=await current();
      await beforeProviderRequest?.();
      await assertCredentialCustody(principal,result.connection,result.env);
      return createFullscriptDraftProvider(result.client).findByMetadata(key);
    }),
  };
}
