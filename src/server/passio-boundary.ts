if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { createHash } from "node:crypto";

/**
 * The Passio Nutrition-AI provider boundary (server-only).
 *
 * DISABLED BY DEFAULT. Nothing here contacts Passio unless an operator
 * deliberately configures protected credentials, and every guard below refuses
 * rather than degrades:
 *
 *   - the licence key lives in server env only and is never returned, logged,
 *     or placed anywhere a browser bundle could reach it; the browser talks to
 *     our own route, never to Passio;
 *   - there is NO fixture fallback. Unconfigured means `not_configured` and an
 *     honest empty state. It never invents a food, a nutrient value, or a
 *     match — a made-up nutrient number is a clinical hazard, not a
 *     placeholder;
 *   - queries are FOOD TERMS. A value shaped like a patient identifier is
 *     refused before any request is made, so a lookup cannot become a quiet
 *     PHI disclosure;
 *   - provenance is a HASH of the response, plus the provider's own timestamp
 *     where it gives one. The response body is not stored;
 *   - image recognition results come back `awaiting_review`. A photographed
 *     meal is a suggestion until a human confirms it.
 *
 * Being CONFIGURED is not the same as having TRANSACTED, so
 * `hasExecutedLiveRequest()` reports the difference and every status surface
 * reads it rather than inferring success from configuration.
 */

export type PassioMode = "disabled" | "live";

export interface PassioConfigReport {
  mode: PassioMode;
  configured: boolean;
  /** Operator-facing reasons, never secrets. */
  problems: string[];
}

const LICENSE_KEY = "PASSIO_LICENSE_KEY";
const CUSTOMER_ID = "PASSIO_CUSTOMER_ID";
const ENABLE_FLAG = "PASSIO_ENABLED";

let testGovernanceApproved = false;

/** Test-only seam. Runtime approval must come from the future durable AWS registry. */
export function __setPassioGovernanceForTest(approved: boolean): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test_connector_registry_refused");
  testGovernanceApproved = approved;
}

function governanceApproved(): boolean {
  // Credentials and environment flags are configuration, never authorization.
  // Production remains unavailable until the durable AWS registry read lands.
  return process.env.NODE_ENV === "test" && testGovernanceApproved;
}

const API_BASE = "https://api.passiolife.com/v2/products/napi";
const TOKEN_BASE = "https://api.passiolife.com/v2/token-cache/napi/oauth/token";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function getPassioConfig(): PassioConfigReport {
  const enabled = env(ENABLE_FLAG) === "1" || env(ENABLE_FLAG).toLowerCase() === "true";
  if (!enabled) {
    return {
      mode: "disabled",
      configured: false,
      problems: [`${ENABLE_FLAG} is not set — the Passio boundary is disabled.`],
    };
  }

  const problems: string[] = [];
  if (!env(LICENSE_KEY)) problems.push(`${LICENSE_KEY} is missing.`);
  if (!env(CUSTOMER_ID)) problems.push(`${CUSTOMER_ID} is missing.`);
  if (!governanceApproved()) problems.push("Governed Passio approval is missing.");

  return {
    mode: problems.length === 0 ? "live" : "disabled",
    configured: problems.length === 0,
    problems,
  };
}

export class PassioNotConfiguredError extends Error {
  readonly code = "not_configured";
  readonly problems: string[];
  constructor(problems: string[]) {
    super("The Passio boundary is not configured.");
    this.name = "PassioNotConfiguredError";
    this.problems = problems;
  }
}

export class PassioRefusedError extends Error {
  readonly code = "refused";
  constructor(message: string) {
    super(message);
    this.name = "PassioRefusedError";
  }
}

export function requirePassio(): PassioConfigReport {
  const report = getPassioConfig();
  if (!report.configured) throw new PassioNotConfiguredError(report.problems);
  return report;
}

/* ------------------------------------------------------------ PHI guard */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGITS = /\d{6,}/;
const DOB = /\b\d{4}-\d{2}-\d{2}\b/;

/**
 * Refuse anything that looks like it identifies a person.
 *
 * This is deliberately blunt. A false refusal costs a practitioner one
 * rephrased search; a false acceptance sends a patient identifier to a third
 * party. Barcodes are long digit strings too, which is why they go through
 * `lookupBarcode` and not through here.
 */
export function assertFoodTermOnly(term: string): void {
  if (UUID.test(term)) {
    throw new PassioRefusedError("That search looks like a record identifier, not a food.");
  }
  if (EMAIL.test(term)) {
    throw new PassioRefusedError("That search looks like an email address, not a food.");
  }
  if (DOB.test(term)) {
    throw new PassioRefusedError("That search looks like a date of birth, not a food.");
  }
  if (LONG_DIGITS.test(term)) {
    throw new PassioRefusedError(
      "That search contains a long number. Use the barcode lookup for barcodes.",
    );
  }
}

/* ------------------------------------------------------------ transport */

let liveRequestExecuted = false;

/** Whether this process has actually completed a Passio request. */
export function hasExecutedLiveRequest(): boolean {
  return liveRequestExecuted;
}

/** Test-only: reset the trackers between cases. */
export function __resetPassioState(): void {
  liveRequestExecuted = false;
  cachedToken = null;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  requirePassio();
  const now = Date.now();
  // Refresh a minute early rather than racing the expiry.
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;

  const res = await fetch(`${TOKEN_BASE}/${encodeURIComponent(env(LICENSE_KEY))}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new PassioRefusedError(`Passio refused the token request (${res.status}).`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new PassioRefusedError("Passio returned no access token.");
  }
  cachedToken = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

export interface PassioResult<T> {
  data: T;
  /** sha256 of the raw response body — provenance without storing the body. */
  responseHash: string;
  httpStatus: number;
  outcome: "ok" | "not_found" | "rate_limited" | "timeout" | "refused" | "error";
  /** The provider's own data timestamp, when it supplies one. */
  providerDataTimestamp: string | null;
}

async function passioGet<T>(path: string): Promise<PassioResult<T>> {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "passio-id": env(CUSTOMER_ID),
      accept: "application/json",
    },
  });

  const raw = await res.text();
  const responseHash = createHash("sha256").update(raw, "utf8").digest("hex");

  if (res.status === 404) {
    return {
      data: null as T,
      responseHash,
      httpStatus: 404,
      outcome: "not_found",
      providerDataTimestamp: null,
    };
  }
  if (res.status === 429) {
    return {
      data: null as T,
      responseHash,
      httpStatus: 429,
      outcome: "rate_limited",
      providerDataTimestamp: null,
    };
  }
  if (!res.ok) {
    // The provider message can echo the submitted query; keep it out of logs.
    throw new PassioRefusedError(`Passio refused the request (${res.status}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PassioRefusedError("Passio returned a body that is not valid JSON.");
  }

  liveRequestExecuted = true;
  const stamp =
    parsed && typeof parsed === "object" && "updatedAt" in parsed
      ? String((parsed as Record<string, unknown>).updatedAt)
      : null;

  return {
    data: parsed as T,
    responseHash,
    httpStatus: res.status,
    outcome: "ok",
    providerDataTimestamp: stamp,
  };
}

/* ------------------------------------------------------------ capabilities */

export interface PassioFood {
  reference: string;
  label: string;
  /** Nutrients are always labelled as the PROVIDER's, never ours. */
  nutrientSource: "passio";
  energyValue: number | null;
  energyUnit: "kcal" | null;
  proteinG: number | null;
  carbohydrateG: number | null;
  fatG: number | null;
  fiberG: number | null;
}

function normaliseFood(row: Record<string, unknown>): PassioFood {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    reference: String(row.id ?? row.referenceId ?? ""),
    label: String(row.displayName ?? row.name ?? ""),
    nutrientSource: "passio",
    // Passio reports energy in kilocalories; the unit is stated rather than
    // implied, because an unlabelled energy number is the bug this phase is
    // built to avoid.
    energyValue: num(row.calories),
    energyUnit: num(row.calories) === null ? null : "kcal",
    proteinG: num(row.protein),
    carbohydrateG: num(row.carbs),
    fatG: num(row.fat),
    fiberG: num(row.fiber),
  };
}

export async function searchFoods(term: string): Promise<PassioResult<PassioFood[]>> {
  requirePassio();
  assertFoodTermOnly(term);
  const result = await passioGet<{ results?: Record<string, unknown>[] }>(
    `/food/search/advanced?term=${encodeURIComponent(term)}`,
  );
  return {
    ...result,
    data: (result.data?.results ?? []).map(normaliseFood),
  };
}

export async function getFoodDetail(reference: string): Promise<PassioResult<PassioFood | null>> {
  requirePassio();
  const result = await passioGet<Record<string, unknown>>(
    `/food/search/result?refCode=${encodeURIComponent(reference)}`,
  );
  return { ...result, data: result.data ? normaliseFood(result.data) : null };
}

export async function lookupBarcode(barcode: string): Promise<PassioResult<PassioFood | null>> {
  requirePassio();
  if (!/^\d{6,14}$/.test(barcode)) {
    throw new PassioRefusedError("That is not a barcode.");
  }
  const result = await passioGet<Record<string, unknown>>(
    `/food/barcode/${encodeURIComponent(barcode)}`,
  );
  return { ...result, data: result.data ? normaliseFood(result.data) : null };
}

export interface PassioRecognition {
  candidates: PassioFood[];
  /** Always. A photograph is a suggestion until a human confirms it. */
  reviewState: "awaiting_review";
}

export async function recogniseImage(
  imageBase64: string,
): Promise<PassioResult<PassioRecognition>> {
  requirePassio();
  const token = await accessToken();
  const res = await fetch(`${API_BASE}/food/recognize`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "passio-id": env(CUSTOMER_ID),
      "content-type": "application/json",
    },
    body: JSON.stringify({ image: imageBase64 }),
  });

  const raw = await res.text();
  const responseHash = createHash("sha256").update(raw, "utf8").digest("hex");
  if (!res.ok) {
    throw new PassioRefusedError(`Passio refused the recognition request (${res.status}).`);
  }

  let parsed: { results?: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(raw) as { results?: Record<string, unknown>[] };
  } catch {
    throw new PassioRefusedError("Passio returned a body that is not valid JSON.");
  }

  liveRequestExecuted = true;
  return {
    data: {
      candidates: (parsed.results ?? []).map(normaliseFood),
      reviewState: "awaiting_review",
    },
    responseHash,
    httpStatus: res.status,
    outcome: "ok",
    providerDataTimestamp: null,
  };
}
