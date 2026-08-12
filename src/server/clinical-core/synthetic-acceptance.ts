if (typeof window !== "undefined") {
  throw new Error("clinical-core/synthetic-acceptance is server-only.");
}

import type { SyntheticAcceptanceManifest } from "./synthetic-fixtures";

export class SyntheticAcceptanceError extends Error {
  constructor(readonly category: "configuration_invalid" | "boundary_refused" | "workflow_failed") {
    super(category);
    this.name = "SyntheticAcceptanceError";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function runSyntheticApiAcceptance(input: {
  apiOrigin: string;
  workforceIdToken: string;
  consumerIdToken: string;
  manifest: SyntheticAcceptanceManifest;
  fetch?: FetchLike;
}): Promise<{ passed: 8; externalRequests: 8 }> {
  const fetcher = input.fetch ?? fetch;
  const origin = validateConfiguration(input);
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const issue = await request(fetcher, origin, "/clinical-core/workforce/invitations", input.workforceIdToken, 201, {
    patientRecordId: input.manifest.fixture.patientRecordId,
    expiresAt,
    idempotencyKey: `acceptance:${Date.now()}`,
  });
  const invitation = data(issue, ["invitationId", "connectionId", "expiresAt", "token"]);
  const token = string(invitation.token);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SyntheticAcceptanceError("workflow_failed");

  const claimed = data(await request(fetcher, origin, "/clinical-core/consumer/invitations/claim", input.consumerIdToken, 200, { token }),
    ["connectionId", "patientRecordId", "consumerPersonId", "state", "verifiedAt"]);
  if (claimed.connectionId !== invitation.connectionId || claimed.patientRecordId !== input.manifest.fixture.patientRecordId
    || claimed.consumerPersonId !== input.manifest.fixture.consumerPersonId || claimed.state !== "verified") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  await request(fetcher, origin, "/clinical-core/consumer/invitations/claim", input.consumerIdToken, 404, { token });
  await request(fetcher, origin, "/clinical-core/workforce/invitations", input.consumerIdToken, [401, 403], {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt,
  });
  await request(fetcher, origin, "/clinical-core/workforce/invitations", input.workforceIdToken, 400, {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt, patientName: "refused",
  });

  const grant = data(await request(fetcher, origin, "/clinical-core/consumer/consents/grant", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId),
    artifactId: input.manifest.fixture.consentArtifactId,
    scope: "programs",
    method: "patient_app",
    representativeAuthority: "self",
  }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
  if (grant.status !== "granted" || grant.version !== 1) throw new SyntheticAcceptanceError("workflow_failed");
  await request(fetcher, origin, "/clinical-core/consumer/consents/grant", input.consumerIdToken, 409, {
    connectionId: string(claimed.connectionId), artifactId: input.manifest.fixture.consentArtifactId,
    scope: "programs", method: "patient_app", representativeAuthority: "self",
  });
  const revoke = data(await request(fetcher, origin, "/clinical-core/consumer/consents/revoke", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId), scope: "programs", reasonCode: "patient_request",
  }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
  if (revoke.status !== "revoked" || revoke.version !== 2) throw new SyntheticAcceptanceError("workflow_failed");
  return { passed: 8, externalRequests: 8 };
}

function validateConfiguration(input: { apiOrigin: string; workforceIdToken: string; consumerIdToken: string; manifest: SyntheticAcceptanceManifest }) {
  let url: URL;
  try { url = new URL(input.apiOrigin); } catch { throw new SyntheticAcceptanceError("configuration_invalid"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
    throw new SyntheticAcceptanceError("configuration_invalid");
  }
  for (const token of [input.workforceIdToken, input.consumerIdToken]) {
    if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new SyntheticAcceptanceError("configuration_invalid");
  }
  if (input.workforceIdToken === input.consumerIdToken) throw new SyntheticAcceptanceError("configuration_invalid");
  return url.origin;
}

async function request(fetcher: FetchLike, origin: string, path: string, bearer: string, expected: number | number[], body: Record<string, unknown>) {
  let response: Response;
  try {
    response = await fetcher(`${origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status) || !response.headers.get("content-type")?.startsWith("application/json")) {
    throw new SyntheticAcceptanceError(response.status === 401 || response.status === 403 ? "boundary_refused" : "workflow_failed");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 16_384) throw new SyntheticAcceptanceError("workflow_failed");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new SyntheticAcceptanceError("workflow_failed"); }
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
