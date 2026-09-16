/** Persisted server-issued identity/consent binding. Never accepted from HTTP input. */
export type VoiceAuthorization = {
  version: 'owned-voice/1'; personId: string; organizationId: string; identitySubject: string;
  consents: Record<'ai_context'|'voice_transcription', {revision:number;releaseVersion:string;contentSha256:string}>;
};
export class VoiceAuthorizationRevoked extends Error {
  readonly status=403;
  constructor(){super('voice_consent_required');}
}
export interface VoiceAuthorizationPolicy {
  verify(job:{owner:string;authorization?:VoiceAuthorization}):Promise<void>;
}
export function sameVoiceAuthorization(a:VoiceAuthorization|undefined,b:VoiceAuthorization|undefined){
  if(!a||!b)return a===b;
  return a.version===b.version&&a.personId===b.personId&&a.organizationId===b.organizationId&&a.identitySubject===b.identitySubject
    &&(['ai_context','voice_transcription'] as const).every(scope=>
      a.consents?.[scope]?.revision===b.consents?.[scope]?.revision
      &&a.consents?.[scope]?.releaseVersion===b.consents?.[scope]?.releaseVersion
      &&a.consents?.[scope]?.contentSha256===b.consents?.[scope]?.contentSha256);
}
