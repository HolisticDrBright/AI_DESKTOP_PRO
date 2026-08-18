if (typeof window !== "undefined") {
  throw new Error("clinical-core/synthetic-acceptance is server-only.");
}

import type { SyntheticAcceptanceManifest } from "./synthetic-fixtures";

export class SyntheticAcceptanceError extends Error {
  constructor(
    readonly category: "configuration_invalid" | "boundary_refused" | "workflow_failed",
    readonly operationIndex?: number,
    readonly statusCode?: number,
    readonly refusalCategory?: string,
  ) {
    super(category);
    this.name = "SyntheticAcceptanceError";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function runSyntheticApiAcceptance(input: {
  apiOrigin: string;
  workforceIdToken: string;
  consumerIdToken: string;
  isolationWorkforceIdToken: string;
  manifest: SyntheticAcceptanceManifest;
  fetch?: FetchLike;
}): Promise<{ passed: 11; externalRequests: 11 }> {
  const fetcher = input.fetch ?? fetch;
  const origin = validateConfiguration(input);
  let operationIndex = 0;
  const call = (path: string, bearer: string, expected: number | number[], body?: Record<string, unknown>) => {
    operationIndex += 1;
    return request(fetcher, origin, path, bearer, expected, body, operationIndex);
  };
  const workforcePosture = data(await call("/clinical-core/workforce/posture", input.workforceIdToken, 200),
    ["contractVersion", "environment", "dataClassification", "identityPool", "authenticated", "phiAllowed", "realPatientDataAllowed"]);
  const consumerPosture = data(await call("/clinical-core/consumer/posture", input.consumerIdToken, 200),
    ["contractVersion", "environment", "dataClassification", "identityPool", "authenticated", "phiAllowed", "realPatientDataAllowed"]);
  for (const [posture, pool] of [[workforcePosture, "workforce"], [consumerPosture, "consumer"]] as const) {
    if (posture.contractVersion !== "clinical-core/1" || posture.environment !== "synthetic-staging"
      || posture.dataClassification !== "synthetic_only" || posture.identityPool !== pool
      || posture.authenticated !== true || posture.phiAllowed !== false || posture.realPatientDataAllowed !== false) {
      throw new SyntheticAcceptanceError("workflow_failed");
    }
  }
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const issue = await call("/clinical-core/workforce/invitations", input.workforceIdToken, 201, {
    patientRecordId: input.manifest.fixture.patientRecordId,
    expiresAt,
    idempotencyKey: `acceptance:${Date.now()}`,
  });
  const invitation = data(issue, ["invitationId", "connectionId", "expiresAt", "token"]);
  const token = string(invitation.token);
  if (!/^[A-HJ-NP-Z2-9]{13}$/.test(token)) throw new SyntheticAcceptanceError("workflow_failed");

  const claimed = data(await call("/clinical-core/consumer/invitations/claim", input.consumerIdToken, 200, { token }),
    ["connectionId", "patientRecordId", "consumerPersonId", "state", "verifiedAt"]);
  if (claimed.connectionId !== invitation.connectionId || claimed.patientRecordId !== input.manifest.fixture.patientRecordId
    || claimed.consumerPersonId !== input.manifest.fixture.consumerPersonId || claimed.state !== "verified") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  await call("/clinical-core/consumer/invitations/claim", input.consumerIdToken, 404, { token });
  await call("/clinical-core/workforce/invitations", input.consumerIdToken, [401, 403], {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt,
  });
  await call("/clinical-core/workforce/invitations", input.workforceIdToken, 400, {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt, patientName: "refused",
  });
  await call("/clinical-core/workforce/invitations", input.isolationWorkforceIdToken, 400, {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt,
  });

  const grant = data(await call("/clinical-core/consumer/consents/grant", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId),
    artifactId: input.manifest.fixture.consentArtifactId,
    scope: "programs",
    method: "patient_app",
    representativeAuthority: "self",
  }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
  if (grant.status !== "granted" || grant.version !== 1) throw new SyntheticAcceptanceError("workflow_failed");
  await call("/clinical-core/consumer/consents/grant", input.consumerIdToken, 409, {
    connectionId: string(claimed.connectionId), artifactId: input.manifest.fixture.consentArtifactId,
    scope: "programs", method: "patient_app", representativeAuthority: "self",
  });
  const revoke = data(await call("/clinical-core/consumer/consents/revoke", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId), scope: "programs", reasonCode: "patient_request",
  }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
  if (revoke.status !== "revoked" || revoke.version !== 2) throw new SyntheticAcceptanceError("workflow_failed");
  return { passed: 11, externalRequests: 11 };
}

function validateConfiguration(input: { apiOrigin: string; workforceIdToken: string; consumerIdToken: string; isolationWorkforceIdToken: string; manifest: SyntheticAcceptanceManifest }) {
  let url: URL;
  try { url = new URL(input.apiOrigin); } catch { throw new SyntheticAcceptanceError("configuration_invalid"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
    throw new SyntheticAcceptanceError("configuration_invalid");
  }
  for (const token of [input.workforceIdToken, input.consumerIdToken, input.isolationWorkforceIdToken]) {
    if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new SyntheticAcceptanceError("configuration_invalid");
  }
  if (new Set([input.workforceIdToken, input.consumerIdToken, input.isolationWorkforceIdToken]).size !== 3) {
    throw new SyntheticAcceptanceError("configuration_invalid");
  }
  return url.origin;
}

async function request(fetcher: FetchLike, origin: string, path: string, bearer: string, expected: number | number[], body: Record<string, unknown> | undefined, operationIndex: number) {
  let response: Response;
  try {
    response = await fetcher(`${origin}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SyntheticAcceptanceError("workflow_failed", operationIndex);
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 16_384) throw new SyntheticAcceptanceError("workflow_failed");
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new SyntheticAcceptanceError("workflow_failed"); }
  if (!statuses.includes(response.status) || !response.headers.get("content-type")?.startsWith("application/json")) {
    const refusalCategory = record(decoded) && typeof decoded.error === "string" && /^[a-z_]+$/.test(decoded.error)
      ? decoded.error : undefined;
    throw new SyntheticAcceptanceError(response.status === 401 || response.status === 403 ? "boundary_refused" : "workflow_failed", operationIndex, response.status, refusalCategory);
  }
  return decoded;
}

function data(value: unknown, exactKeys: string[]) {
  if (!record(value) || !record(value.data) || Object.keys(value).join("|") !== "data"
    || Object.keys(value.data).sort().join("|") !== [...exactKeys].sort().join("|")) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  return value.data;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown) {
  if (typeof value !== "string") throw new SyntheticAcceptanceError("workflow_failed");
  return value;
}
