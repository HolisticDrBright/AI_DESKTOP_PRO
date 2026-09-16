if (typeof window !== "undefined") throw new Error("security-qualification is server-only");
import { createHash } from "node:crypto";
import { createOwnedConsumerApi, type OwnedConsumerApiConfiguration } from "./owned-consumer-api";
import type { createOwnedConsumerRecordsAdapter } from "./owned-consumer-records";
import { createTelehealthHandler, type TelehealthConfiguration } from "./aws-telehealth-requests";
import type { ApiGatewayV2Event } from "./aws-identity-api";

/** Credential-free security qualification.
 *
 * Runs an adversarial request matrix in-process against the production-owned
 * consumer API and the telehealth boundary with a storage adapter that records
 * whether it was ever reached. Every case states the refusal it expects and
 * whether storage may be touched; the report hashes the exact outcomes so a
 * later hosted run can be compared against the same matrix. Passing here is
 * source evidence only, never a substitute for an independent security review
 * or a hosted penetration test. */
export type QualificationCase = {
  id: string; surface: "owned_consumer_api" | "telehealth_boundary"; expectedStatus: number[]; expectedError?: string;
  storageMayBeTouched: boolean; actualStatus: number; actualError: string | null; storageTouched: boolean; leaked: boolean; pass: boolean;
};
export type SecurityQualificationReport = {
  contractVersion: "security-qualification/1"; ranAt: string; passed: boolean; total: number; failed: string[]; cases: QualificationCase[]; evidenceSha256: string;
};
const ID = "11111111-1111-4111-8111-111111111111";
const SECRET_MARKER = "qualification-secret-marker-7f3a";

export async function runSecurityQualification(now = Date.now()): Promise<SecurityQualificationReport> {
  const cases: QualificationCase[] = [];
  const config: OwnedConsumerApiConfiguration = { consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/qualification", consumerAudience: "12345678901234567890",
    phiAllowed: true, activationState: "approved", activationEvidenceSha256: "a".repeat(64), allowedScopes: ["forms_checkins"] };
  const claims = () => ({ iss: config.consumerIssuer, aud: config.consumerAudience, token_use: "id", sub: "qualification-consumer", email_verified: "true",
    "custom:person_id": ID, "custom:organization_id": ID, "custom:production_bound": "true", exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000) - 60 } as Record<string, string | number | boolean | undefined>);
  const event = (route = "GET /clinical-core/consumer/personal/records", patch: Record<string, string | number | boolean | undefined> = {}, extra: Partial<ApiGatewayV2Event> = {}): ApiGatewayV2Event =>
    ({ routeKey: route, queryStringParameters: { collection: "wellness_profiles" }, requestContext: { authorizer: { jwt: { claims: { ...claims(), ...patch } } } }, ...extra });

  async function owned(id: string, expectedStatus: number[], run: (handler: ReturnType<typeof createOwnedConsumerApi>) => Promise<{ statusCode: number; body: string }>,
    options: { configuration?: OwnedConsumerApiConfiguration; expectedError?: string; storageMayBeTouched?: boolean; failing?: boolean } = {}) {
    let touched = false;
    // Constructing the adapter is not storage access; invoking any method is.
    const adapter = () => { if (options.failing) { touched = true; throw new Error(SECRET_MARKER); } return new Proxy({}, { get() { return async () => { touched = true; throw new Error(SECRET_MARKER); }; } }) as ReturnType<typeof createOwnedConsumerRecordsAdapter>; };
    const handler = createOwnedConsumerApi({ configuration: options.configuration ?? config, adapter, now: () => now });
    const result = await run(handler);
    record(id, "owned_consumer_api", expectedStatus, options.expectedError, options.storageMayBeTouched ?? false, result, touched);
  }
  function record(id: string, surface: QualificationCase["surface"], expectedStatus: number[], expectedError: string | undefined, storageMayBeTouched: boolean,
    result: { statusCode: number; body: string }, touched: boolean) {
    let actualError: string | null = null; try { actualError = String(JSON.parse(result.body).error ?? null); } catch { actualError = null; }
    const leaked = result.body.includes(SECRET_MARKER) || result.body.includes(ID);
    const pass = expectedStatus.includes(result.statusCode) && (expectedError === undefined || actualError === expectedError) && (storageMayBeTouched || !touched) && !leaked;
    cases.push({ id, surface, expectedStatus, ...(expectedError ? { expectedError } : {}), storageMayBeTouched, actualStatus: result.statusCode, actualError, storageTouched: touched, leaked, pass });
  }

  await owned("activation_blocked_refuses_before_storage", [503], h => h(event()), { configuration: { ...config, phiAllowed: false, activationState: "blocked", allowedScopes: [] } });
  for (const [name, patch] of Object.entries({ wrong_issuer: { iss: "https://cognito-idp.us-east-2.amazonaws.com/other" }, wrong_audience: { aud: "other" }, expired_token: { exp: Math.floor(now / 1000) },
    future_issued_at: { iat: Math.floor(now / 1000) + 120 }, synthetic_attestation: { "custom:synthetic_attested": "true" }, not_production_bound: { "custom:production_bound": "false" },
    unverified_email: { email_verified: "false" }, access_token_instead_of_id: { token_use: "access" }, malformed_person_id: { "custom:person_id": "not-a-uuid" } })) {
    await owned(`identity_${name}`, [401], h => h(event(undefined, patch as Record<string, string | number | boolean | undefined>)));
  }
  await owned("bearer_header_without_gateway_authorizer", [401], h => { const e = event(); delete e.requestContext; e.headers = { authorization: `Bearer ${"e".repeat(40)}` }; return h(e); });
  await owned("owner_injection_query", [400], h => h(event(undefined, {}, { queryStringParameters: { collection: "wellness_profiles", ownerId: ID } })));
  await owned("malformed_cursor", [400], h => h(event(undefined, {}, { queryStringParameters: { collection: "wellness_profiles", cursor: "../etc" } })));
  await owned("unknown_collection", [400], h => h(event(undefined, {}, { queryStringParameters: { collection: "pg_catalog" } })));
  await owned("workforce_route_on_consumer_pool", [404], h => h(event("GET /clinical-core/workforce/personal/records")));
  await owned("unknown_route", [404], h => h(event("DELETE /clinical-core/consumer/personal/records")));
  await owned("scope_escalation_wearables", [400, 403], h => h(event(undefined, {}, { queryStringParameters: { collection: "wearable_daily_records" } })), { expectedError: "feature_scope_not_enabled" });
  await owned("scope_escalation_reproductive", [400, 403], h => h(event(undefined, {}, { queryStringParameters: { collection: "reproductive_profiles" } })), { expectedError: "feature_scope_not_enabled" });
  await owned("oversized_write_body", [400, 413], h => h(event("POST /clinical-core/consumer/personal/records", {}, { headers: { "content-type": "application/json" }, body: JSON.stringify({ collection: "wellness_profiles", recordId: ID, requestId: ID, expectedRevision: 0, consentRevision: 1, deleted: false, payload: { id: ID, goals: [], onboardingCompleted: false, role: "patient", filler: "x".repeat(300_000) } }) })));
  await owned("malformed_json_body", [400], h => h(event("POST /clinical-core/consumer/personal/records", {}, { headers: { "content-type": "application/json" }, body: "{not json" })));
  await owned("prototype_pollution_body", [400], h => h(event("POST /clinical-core/consumer/personal/records", {}, { headers: { "content-type": "application/json" }, body: '{"__proto__":{"admin":true},"collection":"wellness_profiles"}' })));
  await owned("storage_failure_is_sanitized", [503], h => h(event()), { failing: true, storageMayBeTouched: true, expectedError: "storage_unavailable" });

  const telehealth: TelehealthConfiguration = { tableName: "qualification", consumerIssuer: config.consumerIssuer, consumerAudience: config.consumerAudience, workforceIssuer: `${config.consumerIssuer}-workforce`,
    workforceAudience: "workforce", runtimeMode: "production", phiAllowed: false, zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: "", remindersEnabled: false, reminderSender: "",
    reminderConfigurationSet: "", reminderScheduleGroup: "", reminderSchedulerRoleArn: "", reminderTargetArn: "", stripeTestEnabled: false, stripeSecretArn: "", stripeSuccessUrl: "", stripeCancelUrl: "" };
  const telehealthEvent = (route: string, patch: Record<string, unknown> = {}, body?: Record<string, unknown>) => ({ routeKey: route, headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, requestContext: { authorizer: { jwt: { claims: { ...claims(), email: "qualification@example.test", "custom:synthetic_attested": "true", "custom:production_bound": "false", ...patch } } } } }) as ApiGatewayV2Event;
  const production = createTelehealthHandler(telehealth);
  record("telehealth_production_without_phi_gate", "telehealth_boundary", [503], "production_not_activated", false, await production(telehealthEvent("GET /clinical-core/consumer/appointments/requests")), false);
  const synthetic = createTelehealthHandler({ ...telehealth, runtimeMode: "synthetic" });
  record("telehealth_identity_without_attestation", "telehealth_boundary", [403], "identity_refused", false, await synthetic(telehealthEvent("GET /clinical-core/consumer/appointments/requests", { "custom:synthetic_attested": "false" })), false);
  record("telehealth_workforce_route_with_consumer_claims", "telehealth_boundary", [403], "identity_refused", false, await synthetic(telehealthEvent("GET /clinical-core/workforce/appointments/requests")), false);
  record("telehealth_stripe_webhook_without_boundary", "telehealth_boundary", [503], "provider_unavailable", false, await synthetic({ routeKey: "POST /clinical-core/webhooks/stripe/appointments", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" }), false);
  record("telehealth_reminder_event_when_disabled", "telehealth_boundary", [503], "service_unavailable", false, await synthetic({ internalEvent: "send_appointment_reminder", organizationId: ID, requestId: ID, scheduledStart: new Date(now).toISOString() } as unknown as ApiGatewayV2Event), false);
  record("telehealth_payment_setup_without_stripe", "telehealth_boundary", [503], "provider_unavailable", false, await synthetic(telehealthEvent("POST /clinical-core/consumer/appointments/payment-methods/setup", {}, {})), false);
  record("telehealth_oversized_body", "telehealth_boundary", [400], "request_invalid", false, await synthetic(telehealthEvent("POST /clinical-core/consumer/appointments/holds", {}, { slotId: ID, visitType: "follow_up", note: "x".repeat(20_000) })), false);

  const failed = cases.filter(c => !c.pass).map(c => c.id);
  const evidence = cases.map(({ id, surface, expectedStatus, expectedError, storageMayBeTouched, actualStatus, actualError, storageTouched, leaked, pass }) =>
    ({ id, surface, expectedStatus, expectedError: expectedError ?? null, storageMayBeTouched, actualStatus, actualError, storageTouched, leaked, pass }));
  return { contractVersion: "security-qualification/1", ranAt: new Date(now).toISOString(), passed: failed.length === 0, total: cases.length, failed, cases,
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
