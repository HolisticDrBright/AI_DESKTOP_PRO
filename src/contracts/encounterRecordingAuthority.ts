import { z } from "zod";

const id = z.string().uuid();
const time = z.string().datetime({ offset: true });
const scope = z.enum(["recording", "transcription", "ai_drafting"]);
const kind = z.enum(["patient", "practitioner", "caregiver", "other"]);
export const recordingAuthorityRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("workspace"), encounterId: id,
    locale: z.string().trim().min(2).max(20), jurisdiction: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("readConsentRelease"), encounterId: id, releaseId: id }).strict(),
  z.object({ action: z.literal("addParticipant"), encounterId: id, commandId: id,
    kind, displayName: z.string().trim().min(1).max(200), canSelfConsent: z.boolean() }).strict(),
  z.object({ action: z.literal("grantConsent"), participantId: id, releaseId: id, commandId: id,
    method: z.enum(["verbal_attested", "written", "electronic_signature"]),
    acknowledgment: z.string().trim().min(1).max(2000), representativeAuthorityId: id.nullable() }).strict(),
  z.object({ action: z.literal("withdrawConsent"), consentId: id, reason: z.string().trim().min(1).max(1000) }).strict(),
]);
export type RecordingAuthorityRequest = z.infer<typeof recordingAuthorityRequestSchema>;

const release = z.object({ id, scope, version: z.string().min(1).max(80),
  locale: z.string().min(2).max(20), jurisdiction: z.string().min(1).max(80),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const recordingConsentReleaseSchema = release.extend({ content: z.string().min(1).max(32768) }).strict();
export const recordingWorkspaceSchema = z.object({
  encounterId: id, encounterStatus: z.string().min(1).max(32),
  participants: z.array(z.object({ id, kind, displayName: z.string().min(1).max(200), canSelfConsent: z.boolean(), joinedAt: time,
    consents: z.array(z.object({ id, scope, releaseId: id, status: z.enum(["granted", "withdrawn"]),
      effective: z.boolean(), grantedAt: time, withdrawnAt: time.nullable() }).strict()).max(3),
  }).strict()).max(20),
  consentReleases: z.array(release).max(3),
  activeCapture: z.object({ id, sessionId: id, status: z.enum(["capturing", "paused", "revoked"]),
    createdAt: time, authorityEpoch: z.number().int().nonnegative().safe(), deletionDeadline: time }).strict().nullable(),
  // Finished recordings still inside their deletion deadline, newest first. An
  // authority built before migration 84 omits the key; that reads as none.
  finishedCaptures: z.array(z.object({ id, contentType: z.enum(["audio/webm", "audio/ogg", "audio/wav", "audio/mp4", "audio/mpeg"]),
    createdAt: time, finishedAt: time, deletionDeadline: time, segmentCount: z.number().int().min(1).max(4096),
    transcription: z.object({ jobId: id, status: z.enum(["requested", "processing", "completed"]) }).strict().nullable() }).strict()).max(20).default([]),
}).strict();
export const recordingParticipantReceiptSchema = z.object({ participantId: id }).strict();
export const recordingConsentReceiptSchema = z.object({ consentId: id }).strict();
export const recordingWithdrawalReceiptSchema = z.object({ withdrawn: z.literal(true) }).strict();
export type RecordingWorkspace = z.infer<typeof recordingWorkspaceSchema>;

export const recordingCapabilitiesSchema = z.object({
  consentManagement: z.literal(true), audioCapture: z.literal(false),
  reason: z.literal("audio_transport_not_configured"),
}).strict();
export type RecordingConsentRelease = z.infer<typeof recordingConsentReleaseSchema>;
export function parseRecordingAuthorityResponse(request: RecordingAuthorityRequest, raw: unknown) {
  const dataSchema = request.action === "workspace" ? recordingWorkspaceSchema
    : request.action === "readConsentRelease" ? recordingConsentReleaseSchema
    : request.action === "addParticipant" ? recordingParticipantReceiptSchema
    : request.action === "grantConsent" ? recordingConsentReceiptSchema : recordingWithdrawalReceiptSchema;
  const result = z.object({ data: dataSchema, capabilities: recordingCapabilitiesSchema }).strict().parse(raw);
  if (request.action === "workspace" && (!("encounterId" in result.data) || result.data.encounterId !== request.encounterId)
    || request.action === "readConsentRelease" && (!("id" in result.data) || result.data.id !== request.releaseId)) {
    throw new Error("recording_response_mismatch");
  }
  return result;
}
