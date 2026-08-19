import { describe, expect, test } from "vitest";
import { runSyntheticApiAcceptance } from "./synthetic-acceptance";
import { validateSyntheticAcceptanceManifest } from "./synthetic-fixtures";

const token = (letter: string) => `eyJ${letter.repeat(12)}.${letter.repeat(16)}.${letter.repeat(20)}`;
const manifest = validateSyntheticAcceptanceManifest({
  schemaVersion: "aws-clinical-core-synthetic-acceptance/1",
  environment: "synthetic-staging",
  dataClassification: "synthetic_only",
  containsPhi: false,
  awsAccountId: "123456789012",
  awsRegion: "us-east-2",
  reviewedAt: "2026-08-11T20:00:00Z",
  fixture: {
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationLabel: "Synthetic acceptance clinic",
    workforcePersonId: "22222222-2222-4222-8222-222222222222",
    workforceSubject: "workforce-sub-0001",
    consumerPersonId: "33333333-3333-4333-8333-333333333333",
    consumerSubject: "consumer-sub-0001",
    patientRecordId: "44444444-4444-4444-8444-444444444444",
    consentArtifactId: "55555555-5555-4555-8555-555555555555",
    consentArtifactSha256: "a".repeat(64),
    labConsentArtifactId: "88888888-8888-4888-8888-888888888888",
    labConsentArtifactSha256: "b".repeat(64),
    protocolConsentArtifactId: "12121212-1212-4121-8121-121212121212",
    protocolConsentArtifactSha256: "c".repeat(64),
    nutritionConsentArtifactId: "13131313-1313-4131-8131-131313131313",
    nutritionConsentArtifactSha256: "d".repeat(64),
    symptomsConsentArtifactId: "14141414-1414-4141-8141-141414141414",
    symptomsConsentArtifactSha256: "e".repeat(64),
    formsConsentArtifactId: "15151515-1515-4151-8151-151515151515",
    formsConsentArtifactSha256: "f".repeat(64),
    syncProviderId: "99999999-9999-4999-8999-999999999999",
    isolationOrganizationId: "66666666-6666-4666-8666-666666666666",
    isolationOrganizationLabel: "Synthetic acceptance isolation clinic",
    isolationWorkforcePersonId: "77777777-7777-4777-8777-777777777777",
    isolationWorkforceSubject: "isolation-workforce-sub-0001",
  },
});

function json(status: number, value: unknown) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("deployed synthetic Cognito-to-Aurora acceptance harness", () => {
  test("runs the connection, consent, duplicate-safe lab import, review, and read-back without exposing tokens", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null; authorization: string }> = [];
    const statuses = [
      json(200, { data: { contractVersion: "clinical-core/1", environment: "synthetic-staging", dataClassification: "synthetic_only", identityPool: "workforce", authenticated: true, phiAllowed: false, realPatientDataAllowed: false } }),
      json(200, { data: { contractVersion: "clinical-core/1", environment: "synthetic-staging", dataClassification: "synthetic_only", identityPool: "consumer", authenticated: true, phiAllowed: false, realPatientDataAllowed: false } }),
      json(201, { data: { invitationId: "66666666-6666-4666-8666-666666666666", connectionId: "77777777-7777-4777-8777-777777777777", expiresAt: "2026-08-12T20:00:00Z", token: "ABCDEFGHJKMNP" } }),
      json(200, { data: { connectionId: "77777777-7777-4777-8777-777777777777", patientRecordId: manifest.fixture.patientRecordId, consumerPersonId: manifest.fixture.consumerPersonId, state: "verified", verifiedAt: "2026-08-11T20:00:00Z" } }),
      json(404, { error: "invitation_invalid_or_expired" }),
      json(403, { message: "Forbidden" }),
      json(400, { error: "request_invalid" }),
      json(400, { error: "operation_refused" }),
      json(201, { data: { consentId: "88888888-8888-4888-8888-888888888888", connectionId: "77777777-7777-4777-8777-777777777777", scope: "programs", status: "granted", version: 1, recordedAt: "2026-08-11T20:01:00Z" } }),
      json(409, { error: "consent_precondition_failed" }),
      json(201, { data: { consentId: "99999999-9999-4999-8999-999999999999", connectionId: "77777777-7777-4777-8777-777777777777", scope: "programs", status: "revoked", version: 2, recordedAt: "2026-08-11T20:02:00Z" } }),
      json(200, { data: { connectionId: "77777777-7777-4777-8777-777777777777", patientRecordId: manifest.fixture.patientRecordId, state: "verified", verifiedAt: "2026-08-11T20:00:00Z", labResultsImportConsent: "not_granted" } }),
      json(201, { data: { consentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", connectionId: "77777777-7777-4777-8777-777777777777", scope: "lab_results_import", status: "granted", version: 1, recordedAt: "2026-08-11T20:03:00Z" } }),
      json(200, { data: { connectionId: "77777777-7777-4777-8777-777777777777", patientRecordId: manifest.fixture.patientRecordId, state: "verified", verifiedAt: "2026-08-11T20:00:00Z", labResultsImportConsent: "granted" } }),
      ...(["protocols_supplements", "nutrition", "symptoms_adherence", "forms_checkins"].map((scope, index) => json(201, { data: {
        consentId: `${index + 1}1111111-1111-4111-8111-111111111111`,
        connectionId: "77777777-7777-4777-8777-777777777777", scope,
        status: "granted", version: 1, recordedAt: "2026-08-11T20:04:00Z",
      } }))),
      json(200, { data: [{ scope: "protocols_supplements", status: "granted", recordedAt: "2026-08-11T20:04:00Z", version: 1, method: "patient_app", representativeAuthority: "self" }] }),
      json(202, { data: { versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stableRecordId: "88888888-8888-4888-8888-888888888888", recordKey: "record:acceptance:1", resourceVersion: "acceptance-v1", payload: { id: "synthetic_protocol_acceptance" }, payloadSha256: "a".repeat(64), deleted: false, receivedAt: "2026-08-11T20:05:00Z", duplicate: false } }),
      json(202, { data: { versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stableRecordId: "88888888-8888-4888-8888-888888888888", recordKey: "record:acceptance:1", resourceVersion: "acceptance-v1", payload: { id: "synthetic_protocol_acceptance" }, payloadSha256: "a".repeat(64), deleted: false, receivedAt: "2026-08-11T20:05:00Z", duplicate: true } }),
      json(200, { data: { items: [{ versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }], nextCursor: null } }),
      json(201, { data: { requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "export", status: "submitted", detail: "Synthetic acceptance export", submittedAt: "2026-08-11T20:06:00Z", resolvedAt: null } }),
      json(200, { data: [{ requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "export", status: "submitted", detail: "Synthetic acceptance export", submittedAt: "2026-08-11T20:06:00Z", resolvedAt: null }] }),
      json(400, { error: "request_invalid" }),
      json(202, { data: { eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "review_pending", duplicate: false } }),
      json(202, { data: { eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "review_pending", duplicate: true } }),
      json(200, { data: [{ event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", patient_record_id: manifest.fixture.patientRecordId, marker_name: "Synthetic Glucose", state: "review_pending" }] }),
      json(200, { data: { eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "accepted", observationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", duplicate: false } }),
      json(200, { data: [{ observation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", marker_name: "Synthetic Glucose", review_status: "unreviewed" }] }),
    ];
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
        authorization: String(new Headers(init?.headers).get("authorization")),
      });
      return statuses.shift()!;
    };
    await expect(runSyntheticApiAcceptance({
      apiOrigin: "https://abc123.execute-api.us-east-2.amazonaws.com",
      workforceIdToken: token("a"),
      consumerIdToken: token("b"),
      isolationWorkforceIdToken: token("c"),
      manifest,
      fetch: fetcher,
    })).resolves.toEqual({ passed: 30, externalRequests: 30 });
    expect(calls).toHaveLength(30);
    expect(calls[0]!.body).toBeNull();
    expect(calls[1]!.body).toBeNull();
    expect(calls[2]!.body).not.toHaveProperty("patientName");
    expect(calls[6]!.body).toHaveProperty("patientName", "refused");
    expect(calls[7]!.body).toEqual(expect.objectContaining({ patientRecordId: manifest.fixture.patientRecordId }));
    expect(calls[12]!.body).toEqual(expect.objectContaining({ scope: "lab_results_import" }));
    expect(calls[20]!.body).toEqual(calls[19]!.body);
    expect(calls[24]!.body).toHaveProperty("payload.email", "refused@example.test");
    expect(calls[26]!.body).toEqual(calls[25]!.body);
    expect(calls[27]!.url).toContain("state=review_pending");
    expect(calls[29]!.url).toContain(encodeURIComponent(manifest.fixture.patientRecordId));
    expect(calls.every((call) => call.url.startsWith("https://abc123.execute-api.us-east-2.amazonaws.com/clinical-core/"))).toBe(true);
  });

  test("refuses non-API-Gateway origins and malformed or shared ID tokens before any request", async () => {
    const never = async () => { throw new Error("must not run"); };
    await expect(runSyntheticApiAcceptance({ apiOrigin: "https://example.com", workforceIdToken: token("a"), consumerIdToken: token("b"), isolationWorkforceIdToken: token("c"), manifest, fetch: never }))
      .rejects.toMatchObject({ category: "configuration_invalid" });
    await expect(runSyntheticApiAcceptance({ apiOrigin: "https://abc.execute-api.us-east-2.amazonaws.com", workforceIdToken: token("a"), consumerIdToken: token("a"), isolationWorkforceIdToken: token("c"), manifest, fetch: never }))
      .rejects.toMatchObject({ category: "configuration_invalid" });
  });
});
