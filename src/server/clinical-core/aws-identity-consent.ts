if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-identity-consent is server-only.");
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";

export const CONSENT_SCOPES = [
  "programs",
  "protocols_supplements",
  "nutrition",
  "appointments",
  "messaging",
  "forms_checkins",
  "symptoms_adherence",
  "wearables",
  "lab_summaries",
  "lab_results_import",
  "billing_links",
  "research_n_of_1",
] as const;

export type ConsentScope = (typeof CONSENT_SCOPES)[number];
export type IdentityPool = "workforce" | "consumer";
export type ConsentMethod = "patient_app" | "portal" | "in_person" | "written";
export type RepresentativeAuthority = "self" | "guardian" | "healthcare_proxy" | "legal_representative";

export type SyntheticRequestContext = {
  actorPersonId: string;
  organizationId: string;
  identityPool: IdentityPool;
  /** Verified Cognito `sub`; opaque and never derived from contact information. */
  identitySubject: string;
  purpose: "identity_link" | "consent_management";
  environment: "synthetic-staging";
  dataClassification: "synthetic_only";
  containsPhi: false;
  realPatientData: false;
};

export type InvitationResult = {
  invitationId: string;
  connectionId: string;
  expiresAt: string;
  /** Returned once by this process; the database receives only its SHA-256. */
  token: string;
};

export type ConnectionResult = {
  connectionId: string;
  patientRecordId: string;
  consumerPersonId: string;
  state: "verified";
  verifiedAt: string;
};

export type ConsentResult = {
  consentId: string;
  connectionId: string;
  scope: ConsentScope;
  status: "granted" | "revoked";
  version: number;
  recordedAt: string;
};

export class ClinicalCoreAdapterError extends Error {
  constructor(readonly category:
    | "synthetic_boundary_refused"
    | "request_context_invalid"
    | "invitation_invalid_or_expired"
    | "consent_precondition_failed"
    | "database_unavailable") {
    super(category);
    this.name = "ClinicalCoreAdapterError";
  }
}

export interface AwsSyntheticIdentityConsentAdapter {
  issueInvitation(input: {
    context: SyntheticRequestContext;
    patientRecordId: string;
    expiresAt: string;
    idempotencyKey?: string;
  }): Promise<InvitationResult>;
  claimInvitation(input: {
    context: SyntheticRequestContext;
    token: string;
  }): Promise<ConnectionResult>;
  recordConsent(input: {
    context: SyntheticRequestContext;
    connectionId: string;
    artifactId: string;
    scope: ConsentScope;
    method: ConsentMethod;
    representativeAuthority: RepresentativeAuthority;
  }): Promise<ConsentResult>;
  revokeConsent(input: {
    context: SyntheticRequestContext;
    connectionId: string;
    scope: ConsentScope;
    reasonCode: "patient_request" | "scope_changed" | "connection_revoked";
  }): Promise<ConsentResult>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITATION_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{13}$/;

export function normalizeInvitationCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

function generateInvitationCode(): string {
  return [...randomBytes(13)]
    .map((byte) => INVITATION_ALPHABET[byte & 31])
    .join("");
}

export function createAwsSyntheticIdentityConsentAdapter(
  database: ClinicalCoreDatabase,
): AwsSyntheticIdentityConsentAdapter {
  return {
    async issueInvitation(input) {
      assertContext(input.context, "workforce", "identity_link");
      assertUuid(input.patientRecordId);
      const expiresAt = new Date(input.expiresAt);
      const lifetime = expiresAt.getTime() - Date.now();
      if (!Number.isFinite(expiresAt.getTime()) || lifetime <= 0 || lifetime > 48 * 60 * 60 * 1_000) {
        throw new ClinicalCoreAdapterError("request_context_invalid");
      }

      // Thirteen characters from a 32-symbol, ambiguity-free alphabet = 65 bits.
      // The code remains short-lived, single-use, and hash-only at rest.
      const token = generateInvitationCode();
      const tokenHash = sha256(token);
      const idempotencyKey = input.idempotencyKey ?? randomUUID();
      assertBoundedIdempotencyKey(idempotencyKey);

      const row = await run(database, input.context, async (tx) => firstRow<{
        invitation_id: string;
        connection_id: string;
        expires_at: string;
      }>(await tx.query(
        "select * from clinical_core.issue_connection_invitation($1, $2, $3, $4::timestamptz, $5)",
        [clinicalUuid(input.context.organizationId), clinicalUuid(input.patientRecordId), tokenHash, expiresAt.toISOString(), idempotencyKey],
      )), "request_context_invalid");
      return {
        invitationId: row.invitation_id,
        connectionId: row.connection_id,
        expiresAt: row.expires_at,
        token,
      };
    },

    async claimInvitation(input) {
      assertContext(input.context, "consumer", "identity_link");
      const token = normalizeInvitationCode(input.token);
      if (!INVITATION_CODE_PATTERN.test(token)) {
        throw new ClinicalCoreAdapterError("invitation_invalid_or_expired");
      }
      const row = await run(database, input.context, async (tx) => firstRow<{
        connection_id: string;
        patient_record_id: string;
        consumer_person_id: string;
        state: "verified";
        verified_at: string;
      }>(await tx.query(
        "select * from clinical_core.claim_connection_invitation($1, $2)",
        [sha256(token), clinicalUuid(input.context.actorPersonId)],
      ), "invitation_invalid_or_expired"), "invitation_invalid_or_expired");
      return {
        connectionId: row.connection_id,
        patientRecordId: row.patient_record_id,
        consumerPersonId: row.consumer_person_id,
        state: row.state,
        verifiedAt: row.verified_at,
      };
    },

    async recordConsent(input) {
      assertContext(input.context, undefined, "consent_management");
      assertUuid(input.connectionId);
      assertUuid(input.artifactId);
      if (!CONSENT_SCOPES.includes(input.scope)) {
        throw new ClinicalCoreAdapterError("consent_precondition_failed");
      }
      const row = await run(database, input.context, async (tx) => firstConsent(await tx.query(
        "select * from clinical_core.record_consent_grant($1, $2, $3, $4, $5)",
        [clinicalUuid(input.connectionId), clinicalUuid(input.artifactId), input.scope, input.method, input.representativeAuthority],
      )), "consent_precondition_failed");
      return toConsent(row);
    },

    async revokeConsent(input) {
      assertContext(input.context, undefined, "consent_management");
      assertUuid(input.connectionId);
      if (!CONSENT_SCOPES.includes(input.scope)) {
        throw new ClinicalCoreAdapterError("consent_precondition_failed");
      }
      const row = await run(database, input.context, async (tx) => firstConsent(await tx.query(
        "select * from clinical_core.revoke_consent_grant($1, $2, $3)",
        [clinicalUuid(input.connectionId), input.scope, input.reasonCode],
      )), "consent_precondition_failed");
      return toConsent(row);
    },
  };
}

async function run<T>(
  database: ClinicalCoreDatabase,
  context: SyntheticRequestContext,
  work: (tx: ClinicalCoreTransaction) => Promise<T>,
  operationRefusal: ClinicalCoreAdapterError["category"] = "database_unavailable",
): Promise<T> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select clinical_private.set_request_context($1, $2, $3, $4, $5, $6, $7)", [
        clinicalUuid(context.actorPersonId),
        clinicalUuid(context.organizationId),
        context.identityPool,
        context.identitySubject,
        context.purpose,
        context.environment,
        context.dataClassification,
      ]);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof ClinicalCoreAdapterError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) {
      throw new ClinicalCoreAdapterError(error.category === "identity_refused" ? "synthetic_boundary_refused" : operationRefusal);
    }
    throw new ClinicalCoreAdapterError("database_unavailable");
  }
}

function assertContext(
  context: SyntheticRequestContext,
  requiredPool: IdentityPool | undefined,
  requiredPurpose: SyntheticRequestContext["purpose"],
) {
  if (
    context.environment !== "synthetic-staging"
    || context.dataClassification !== "synthetic_only"
    || context.containsPhi !== false
    || context.realPatientData !== false
    || context.purpose !== requiredPurpose
    || (requiredPool && context.identityPool !== requiredPool)
    || !UUID_PATTERN.test(context.actorPersonId)
    || !UUID_PATTERN.test(context.organizationId)
    || !/^[A-Za-z0-9:_-]{8,128}$/.test(context.identitySubject)
  ) {
    throw new ClinicalCoreAdapterError("synthetic_boundary_refused");
  }
}

function assertUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new ClinicalCoreAdapterError("request_context_invalid");
}

function assertBoundedIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) {
    throw new ClinicalCoreAdapterError("request_context_invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function firstRow<Row extends Record<string, unknown>>(
  result: { rows: Row[] },
  emptyCategory: ClinicalCoreAdapterError["category"] = "database_unavailable",
): Row {
  const row = result.rows[0];
  if (!row) throw new ClinicalCoreAdapterError(emptyCategory);
  return row;
}

type ConsentRow = {
  consent_id: string;
  connection_id: string;
  scope: ConsentScope;
  status: "granted" | "revoked";
  version: number;
  recorded_at: string;
};

function firstConsent(result: { rows: ConsentRow[] }): ConsentRow {
  return firstRow(result, "consent_precondition_failed");
}

function toConsent(row: ConsentRow): ConsentResult {
  return {
    consentId: row.consent_id,
    connectionId: row.connection_id,
    scope: row.scope,
    status: row.status,
    version: row.version,
    recordedAt: row.recorded_at,
  };
}
