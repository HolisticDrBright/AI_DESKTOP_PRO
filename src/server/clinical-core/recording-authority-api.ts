import type { ApiGatewayV2Event, ApiGatewayV2Response } from "./aws-identity-api";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
import { recordingAuthorityRequestSchema } from "@/contracts/encounterRecordingAuthority";
import { RecordingAuthorityError, type createEncounterRecordingOperations } from "./encounter-recording-operations";

export const RECORDING_AUTHORITY_ROUTE = "POST /clinical-core/workforce/encounter-recording/authority";
export type RecordingAuthorityConfiguration = {
  workforceIssuer: string; workforceAudience: string; organizationId: string;
  phiAllowed: boolean; activation: "blocked" | "approved";
  activationEvidenceSha256?: string; mfaReviewSha256?: string; databaseReviewSha256?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
/** API Gateway must verify JWT signatures; caller headers are never decoded as
 * identity. This API manages consent only, not audio capture or provider jobs. */
export function createRecordingAuthorityApi(input: {
  configuration: RecordingAuthorityConfiguration;
  operations: () => ReturnType<typeof createEncounterRecordingOperations>;
  now?: () => number;
}) {
  const c = input.configuration;
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.workforceIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(c.workforceAudience) || !uuid.test(c.organizationId)
    || !["approved", "blocked"].includes(c.activation)) throw new Error("recording_api_configuration_invalid");
  const active = c.phiAllowed === true && c.activation === "approved"
    && hash.test(c.activationEvidenceSha256 ?? "") && hash.test(c.mfaReviewSha256 ?? "") && hash.test(c.databaseReviewSha256 ?? "");
  if (c.phiAllowed && !active) throw new Error("recording_api_activation_invalid");
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!active) return reply(503, { error: "production_not_activated", phiAllowed: false });
    if (event.routeKey !== RECORDING_AUTHORITY_ROUTE) return reply(404, { error: "route_not_found" });
    try {
      const context = identity(event, c, input.now?.() ?? Date.now());
      const type = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1];
      if (Object.keys(event.queryStringParameters ?? {}).length || type?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        || typeof event.body !== "string" || event.body.length > 16000) throw new RecordingAuthorityError("request_invalid");
      const bytes = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
      if (bytes.length > 10000 || event.isBase64Encoded && bytes.toString("base64") !== event.body)
        throw new RecordingAuthorityError("request_invalid");
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new RecordingAuthorityError("request_invalid"); }
      const request = recordingAuthorityRequestSchema.safeParse(raw);
      if (!request.success) throw new RecordingAuthorityError("request_invalid");
      return reply(200, { data: await input.operations()(context, request.data),
        capabilities: { consentManagement: true, audioCapture: false, reason: "audio_transport_not_configured" } });
    } catch (error) {
      const code = error instanceof RecordingAuthorityError ? error.code : "service_unavailable";
      return reply(code === "reauth_required" ? 401 : code === "request_invalid" ? 400 : code === "conflict" ? 409
        : ["recording_access_refused", "recording_consent_required"].includes(code) ? 403 : 503, { error: code });
    }
  };
}
function identity(event: ApiGatewayV2Event, c: RecordingAuthorityConfiguration, now: number): ProductionClinicalRequestContext {
  const v = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const numericTime = (n: unknown) => (typeof n === "number" || typeof n === "string" && /^\d+$/.test(n))
    && Number.isSafeInteger(Number(n)) && Number(n) > 0;
  if (v.iss !== c.workforceIssuer || v.aud !== c.workforceAudience || v.token_use !== "id"
    || v["custom:production_bound"] !== "true" || ![true, "true"].includes(v.email_verified as string | boolean)
    || [true, "true"].includes(v["custom:synthetic_attested"] as string | boolean)
    || typeof v.sub !== "string" || !/^[A-Za-z0-9:_-]{8,128}$/.test(v.sub)
    || typeof v["custom:person_id"] !== "string" || !uuid.test(v["custom:person_id"])
    || v["custom:organization_id"] !== c.organizationId || ![v.exp, v.iat, v.auth_time].every(numericTime)
    || !Number.isFinite(now) || Number(v.exp) * 1000 <= now || Number(v.iat) >= Number(v.exp)
    || Number(v.iat) * 1000 > now + 60000 || Number(v.auth_time) > Number(v.iat)
    || now - Number(v.auth_time) * 1000 > 15 * 60000)
    throw new RecordingAuthorityError("reauth_required");
  return { actorPersonId: v["custom:person_id"], organizationId: c.organizationId, identitySubject: v.sub,
    identityPool: "workforce", purpose: "clinical_data", environment: "production-clinical",
    dataClassification: "clinical_phi", containsPhi: true, realPatientData: true, productionBound: true };
}
function reply(statusCode: number, value: unknown): ApiGatewayV2Response {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(value) };
}
