if (typeof window !== "undefined") {
  throw new Error("clinical-core/synthetic-api-client is server-only.");
}

export type ClinicalCoreIdentityPool = "workforce" | "consumer";

export interface SyntheticClinicalCorePosture {
  contractVersion: "clinical-core/1";
  environment: "synthetic-staging";
  dataClassification: "synthetic_only";
  identityPool: ClinicalCoreIdentityPool;
  authenticated: true;
  phiAllowed: false;
  realPatientDataAllowed: false;
}

export class SyntheticClinicalCoreUnavailable extends Error {
  readonly code = "synthetic_clinical_core_unavailable";
  constructor() {
    super("The synthetic clinical core is unavailable.");
    this.name = "SyntheticClinicalCoreUnavailable";
  }
}

const API_HOST = /^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/;
const MAX_RESPONSE_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITATION_CODE = /^[A-HJ-NP-Z2-9]{13}$/;

function apiOrigin(): string {
  if (process.env.CLINICAL_AWS_RUNTIME_MODE !== "synthetic") throw new SyntheticClinicalCoreUnavailable();
  const raw = (process.env.CLINICAL_AWS_API_ORIGIN ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SyntheticClinicalCoreUnavailable();
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !API_HOST.test(url.hostname)) {
    throw new SyntheticClinicalCoreUnavailable();
  }
  return url.origin;
}

function bearer(value: string): string {
  const token = value.replace(/^Bearer\s+/i, "").trim();
  if (!/^[A-Za-z0-9._-]{100,8192}$/.test(token)) throw new SyntheticClinicalCoreUnavailable();
  return token;
}

function isPosture(value: unknown, pool: ClinicalCoreIdentityPool): value is SyntheticClinicalCorePosture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.contractVersion === "clinical-core/1"
    && row.environment === "synthetic-staging"
    && row.dataClassification === "synthetic_only"
    && row.identityPool === pool
    && row.authenticated === true
    && row.phiAllowed === false
    && row.realPatientDataAllowed === false
    && Object.keys(row).length === 7;
}

export async function getSyntheticClinicalCorePosture(
  pool: ClinicalCoreIdentityPool,
  authorization: string,
): Promise<SyntheticClinicalCorePosture> {
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}/clinical-core/${pool}/posture`, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${bearer(authorization)}`, accept: "application/json" },
    });
  } catch {
    throw new SyntheticClinicalCoreUnavailable();
  }
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new SyntheticClinicalCoreUnavailable();
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new SyntheticClinicalCoreUnavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyntheticClinicalCoreUnavailable();
  }
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).data
    : undefined;
  if (!isPosture(data, pool)) throw new SyntheticClinicalCoreUnavailable();
  return data;
}

export interface SyntheticPatientInvitation {
  invitationId: string;
  connectionId: string;
  expiresAt: string;
  token: string;
}

function isInvitation(value: unknown): value is SyntheticPatientInvitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.invitationId === "string" && UUID.test(row.invitationId)
    && typeof row.connectionId === "string" && UUID.test(row.connectionId)
    && typeof row.expiresAt === "string" && Number.isFinite(new Date(row.expiresAt).getTime())
    && typeof row.token === "string" && INVITATION_CODE.test(row.token)
    && Object.keys(row).length === 4;
}

/** Issue one hash-at-rest, short-lived AWS invitation for an anonymous test chart. */
export async function issueSyntheticPatientInvitation(
  authorization: string,
  patientRecordId: string,
): Promise<SyntheticPatientInvitation> {
  if (!UUID.test(patientRecordId)) throw new SyntheticClinicalCoreUnavailable();
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}/clinical-core/workforce/invitations`, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${bearer(authorization)}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        patientRecordId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      }),
    });
  } catch {
    throw new SyntheticClinicalCoreUnavailable();
  }
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new SyntheticClinicalCoreUnavailable();
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new SyntheticClinicalCoreUnavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyntheticClinicalCoreUnavailable();
  }
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).data
    : undefined;
  if (!isInvitation(data)) throw new SyntheticClinicalCoreUnavailable();
  return data;
}
