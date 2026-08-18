import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ClinicalCoreAdapterError,
  createAwsSyntheticIdentityConsentAdapter,
  type SyntheticRequestContext,
} from "./aws-identity-consent";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreQueryResult } from "./database";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const INVITATION = "55555555-5555-4555-8555-555555555555";
const ARTIFACT = "66666666-6666-4666-8666-666666666666";
const CONSENT = "77777777-7777-4777-8777-777777777777";

type Call = { sql: string; parameters: readonly unknown[] };

function context(overrides: Partial<SyntheticRequestContext> = {}): SyntheticRequestContext {
  return {
    actorPersonId: ACTOR,
    organizationId: ORG,
    identityPool: "workforce",
    identitySubject: "synthetic-subject-001",
    purpose: "identity_link",
    environment: "synthetic-staging",
    dataClassification: "synthetic_only",
    containsPhi: false,
    realPatientData: false,
    ...overrides,
  };
}

function fakeDatabase(
  resultFor: (sql: string) => ClinicalCoreQueryResult = () => ({ rows: [] }),
) {
  const calls: Call[] = [];
  let transactions = 0;
  const database: ClinicalCoreDatabase = {
    async transaction(work) {
      transactions += 1;
      return work({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
          calls.push({ sql, parameters });
          return resultFor(sql) as ClinicalCoreQueryResult<Row>;
        },
      });
    },
  };
  return { database, calls, transactions: () => transactions };
}

describe("AWS synthetic identity and consent adapter", () => {
  test("issues a 13-character invitation code once and persists only its SHA-256", async () => {
    const db = fakeDatabase((sql) => sql.includes("issue_connection_invitation") ? {
      rows: [{ invitation_id: INVITATION, connection_id: CONNECTION, expires_at: "2026-08-12T18:00:00.000Z" }],
    } : { rows: [] });
    const adapter = createAwsSyntheticIdentityConsentAdapter(db.database);
    const result = await adapter.issueInvitation({
      context: context(),
      patientRecordId: PATIENT,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      idempotencyKey: "invite:test:0001",
    });

    expect(result.token).toMatch(/^[A-HJ-NP-Z2-9]{13}$/);
    expect(db.transactions()).toBe(1);
    expect(db.calls[0]!.sql).toContain("set_request_context");
    expect(db.calls[0]!.parameters).toContain("synthetic-subject-001");
    const mutation = db.calls[1]!;
    expect(mutation.sql).toContain("issue_connection_invitation");
    expect(mutation.sql).toContain("$4::timestamptz");
    expect(mutation.parameters).not.toContain(result.token);
    expect(mutation.parameters[2]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses invitation lifetimes outside the 48-hour synthetic boundary", async () => {
    const db = fakeDatabase();
    const adapter = createAwsSyntheticIdentityConsentAdapter(db.database);
    await expect(adapter.issueInvitation({
      context: context(),
      patientRecordId: PATIENT,
      expiresAt: new Date(Date.now() + 49 * 60 * 60 * 1_000).toISOString(),
    })).rejects.toThrow(/request_context_invalid/);
    expect(db.transactions()).toBe(0);
  });

  test("claims only with a consumer identity and hashes the presented token", async () => {
    const db = fakeDatabase((sql) => sql.includes("claim_connection_invitation") ? {
      rows: [{
        connection_id: CONNECTION,
        patient_record_id: PATIENT,
        consumer_person_id: ACTOR,
        state: "verified",
        verified_at: "2026-08-12T18:00:00.000Z",
      }],
    } : { rows: [] });
    const adapter = createAwsSyntheticIdentityConsentAdapter(db.database);
    const token = "ABCDEFGHJKMNP";
    const result = await adapter.claimInvitation({
      context: context({ identityPool: "consumer" }),
      token,
    });
    expect(result.state).toBe("verified");
    expect(db.calls[1]!.parameters[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(db.calls[1]!.parameters).not.toContain(token);
  });

  test("normalizes spaces, hyphens, and lowercase before hashing a code", async () => {
    const db = fakeDatabase((sql) => sql.includes("claim_connection_invitation") ? {
      rows: [{ connection_id: CONNECTION, patient_record_id: PATIENT, consumer_person_id: ACTOR,
        state: "verified", verified_at: "2026-08-12T18:00:00.000Z" }],
    } : { rows: [] });
    const adapter = createAwsSyntheticIdentityConsentAdapter(db.database);
    await adapter.claimInvitation({
      context: context({ identityPool: "consumer" }),
      token: "abcd-efgh-jkmnp",
    });
    const expected = createHash("sha256").update("ABCDEFGHJKMNP", "utf8").digest("hex");
    expect(db.calls[1]!.parameters[0]).toBe(expected);
  });

  test("does not permit contact information to substitute for an invitation", async () => {
    const db = fakeDatabase();
    const adapter = createAwsSyntheticIdentityConsentAdapter(db.database);
    await expect(adapter.claimInvitation({
      context: context({ identityPool: "consumer" }),
      token: "person@example.test",
    })).rejects.toThrow(/invitation_invalid_or_expired/);
    expect(db.transactions()).toBe(0);
  });

  test("records a versioned grant against an approved artifact", async () => {
    const db = fakeDatabase((sql) => sql.includes("record_consent_grant") ? {
      rows: [{
        consent_id: CONSENT,
        connection_id: CONNECTION,
        scope: "wearables",
        status: "granted",
        version: 1,
        recorded_at: "2026-08-12T18:00:00.000Z",
      }],
    } : { rows: [] });
    const result = await createAwsSyntheticIdentityConsentAdapter(db.database).recordConsent({
      context: context({ purpose: "consent_management" }),
      connectionId: CONNECTION,
      artifactId: ARTIFACT,
      scope: "wearables",
      method: "in_person",
      representativeAuthority: "self",
    });
    expect(result).toMatchObject({ status: "granted", scope: "wearables", version: 1 });
    expect(db.calls[1]!.parameters).toEqual([
      clinicalUuid(CONNECTION), clinicalUuid(ARTIFACT), "wearables", "in_person", "self",
    ]);
  });

  test("revocation is a new consent version with a bounded reason code", async () => {
    const db = fakeDatabase((sql) => sql.includes("revoke_consent_grant") ? {
      rows: [{
        consent_id: CONSENT,
        connection_id: CONNECTION,
        scope: "nutrition",
        status: "revoked",
        version: 2,
        recorded_at: "2026-08-12T18:00:00.000Z",
      }],
    } : { rows: [] });
    const result = await createAwsSyntheticIdentityConsentAdapter(db.database).revokeConsent({
      context: context({ purpose: "consent_management", identityPool: "consumer" }),
      connectionId: CONNECTION,
      scope: "nutrition",
      reasonCode: "patient_request",
    });
    expect(result).toMatchObject({ status: "revoked", version: 2 });
    expect(db.calls[1]!.parameters).toEqual([clinicalUuid(CONNECTION), "nutrition", "patient_request"]);
  });

  test.each([
    ["production", { environment: "production" }],
    ["PHI", { containsPhi: true }],
    ["real patient", { realPatientData: true }],
    ["unbound identity", { identitySubject: "" }],
  ])("refuses %s context before opening a transaction", async (_name, override) => {
    const db = fakeDatabase();
    const adapter = createAwsSyntheticIdentityConsentAdapter(db.database);
    await expect(adapter.issueInvitation({
      context: context(override as Partial<SyntheticRequestContext>),
      patientRecordId: PATIENT,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    })).rejects.toBeInstanceOf(ClinicalCoreAdapterError);
    expect(db.transactions()).toBe(0);
  });

  test("maps database details to one PHI-safe failure category", async () => {
    const database: ClinicalCoreDatabase = {
      async transaction() {
        throw new Error("secret connection string and raw database detail");
      },
    };
    await expect(createAwsSyntheticIdentityConsentAdapter(database).claimInvitation({
      context: context({ identityPool: "consumer" }),
      token: "ABCDEFGHJKMNP",
    })).rejects.toThrow(/^database_unavailable$/);
  });

  test("preserves bounded identity and operation refusals without database text", async () => {
    const rejecting = (category: "identity_refused" | "operation_refused"): ClinicalCoreDatabase => ({
      async transaction() { throw new ClinicalCoreDatabaseRejection(category); },
    });
    const claim = { context: context({ identityPool: "consumer" as const }), token: "ABCDEFGHJKMNP" };
    await expect(createAwsSyntheticIdentityConsentAdapter(rejecting("identity_refused")).claimInvitation(claim))
      .rejects.toThrow(/^synthetic_boundary_refused$/);
    await expect(createAwsSyntheticIdentityConsentAdapter(rejecting("operation_refused")).claimInvitation(claim))
      .rejects.toThrow(/^invitation_invalid_or_expired$/);
  });

  test("the public adapter contract has no demographic or contact matching fields", () => {
    const source = readFileSync(path.join(process.cwd(), "src/server/clinical-core/aws-identity-consent.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/\b(email|phone|dateOfBirth|firstName|lastName)\b/);
  });
});
