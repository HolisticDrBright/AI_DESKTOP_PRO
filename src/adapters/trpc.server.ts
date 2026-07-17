if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { TRPC_BASE_URL } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { AdapterError, codeFromHttpStatus, type AdapterErrorCode } from "./errors";

/**
 * Minimal, dependency-free tRPC HTTP client for the shared backend.
 * Server-only. Presents the practitioner's bearer token so the backend runs
 * RLS as that user; the desktop reaches Postgres ONLY through this backend
 * (ADR 0002), never directly.
 *
 * Kept intentionally tiny (no @trpc/client dependency). Reads/writes use the
 * superjson wire shape ({ json: <value> }); the response's `result.data.json`
 * is the unwrapped value. Every failure is normalized to an AdapterError with
 * a safe message — response bodies (possible PHI) never reach the thrown
 * message, only server-side `detail`.
 */

interface TrpcError {
  error?: { json?: { message?: string; data?: { code?: string; httpStatus?: number } } };
}

/**
 * Backend error text is discarded by default (it could carry sensitive
 * detail). These EXACT server-owned constants — membership guard copy the
 * backend composes itself, no interpolation, no PHI — are the only messages
 * allowed through to the UI. Anything else falls back to the generic message
 * for the mapped code.
 */
const SAFE_SERVER_MESSAGES = new Set<string>([
  "That person is already a member of this organization.",
  "You cannot remove your own membership.",
  "An organization must keep at least one owner.",
  "No account exists for that email, and email invitations are not configured on this backend. Ask them to create an account first, then add them by email.",
]);

/** Map a tRPC error code / HTTP status to our adapter code. */
function mapCode(trpcCode: string | undefined, httpStatus: number): AdapterErrorCode {
  switch (trpcCode) {
    case "UNAUTHORIZED":
      return "unauthenticated";
    case "FORBIDDEN":
      return "forbidden";
    case "NOT_FOUND":
      return "not_found";
    case "BAD_REQUEST":
    case "PARSE_ERROR":
    case "UNPROCESSABLE_CONTENT":
      return "invalid";
    case "PRECONDITION_FAILED":
      // State/consent preconditions (0022 SQLSTATE 55000): a conflict with
      // current server state, not malformed input — surfaces as HTTP 409 so
      // capture UIs stop and re-check.
      return "conflict";
    case "CONFLICT":
      return "conflict";
    default:
      return codeFromHttpStatus(httpStatus);
  }
}

async function call<T>(
  path: string,
  method: "GET" | "POST",
  input?: unknown,
  sessionToken?: string | null,
): Promise<T> {
  let token: string;
  try {
    token = await getClinicalAccessToken(sessionToken);
  } catch (e) {
    // Preserve typed auth errors (signed-out ≠ backend down); wrap the rest.
    if (e instanceof AdapterError) throw e;
    throw new AdapterError(
      "unavailable",
      undefined,
      `token: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let url = `${TRPC_BASE_URL}/${path}`;
  let bodyInit: string | undefined;

  if (method === "GET") {
    if (input !== undefined) {
      const u = new URL(url);
      u.searchParams.set("input", JSON.stringify({ json: input }));
      url = u.toString();
    }
  } else {
    headers["content-type"] = "application/json";
    bodyInit = JSON.stringify({ json: input ?? null });
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: bodyInit, cache: "no-store" });
  } catch (e) {
    // Network failure / backend unreachable (the state in this sandbox).
    throw new AdapterError(
      "unavailable",
      undefined,
      `fetch ${path}: ${e instanceof Error ? e.message : "network error"}`,
    );
  }

  let body: { result?: { data?: { json?: T } } } | TrpcError;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new AdapterError("unknown", undefined, `tRPC ${path}: non-JSON response (${res.status})`);
  }

  if (!res.ok || "error" in body) {
    const e = body as TrpcError;
    const trpcCode = e.error?.json?.data?.code;
    const code = mapCode(trpcCode, res.status);
    // Safe message only; the (potentially sensitive) server message stays in
    // detail — unless it is one of the exact allowlisted server constants.
    const serverMessage = e.error?.json?.message;
    const safe = serverMessage && SAFE_SERVER_MESSAGES.has(serverMessage) ? serverMessage : undefined;
    throw new AdapterError(code, safe, `tRPC ${path} (${trpcCode ?? res.status})`);
  }

  return (body as { result: { data: { json: T } } }).result.data.json;
}

export function trpcQuery<T>(path: string, input?: unknown, sessionToken?: string | null): Promise<T> {
  return call<T>(path, "GET", input, sessionToken);
}

export function trpcMutation<T>(path: string, input?: unknown, sessionToken?: string | null): Promise<T> {
  return call<T>(path, "POST", input, sessionToken);
}

/**
 * Multipart POST to a non-tRPC backend endpoint (same host as TRPC_BASE_URL,
 * e.g. /api/clinical/labs/upload — file uploads can't ride the superjson
 * link). Same auth + error normalization as the tRPC calls; the backend's
 * error envelope { error: { code, message } } already speaks AdapterError
 * codes.
 */
export async function backendUpload<T>(
  path: string,
  form: FormData,
  sessionToken?: string | null,
): Promise<T> {
  let token: string;
  try {
    token = await getClinicalAccessToken(sessionToken);
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    throw new AdapterError(
      "unavailable",
      undefined,
      `token: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  const base = TRPC_BASE_URL.replace(/\/api\/trpc\/?$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      cache: "no-store",
    });
  } catch (e) {
    throw new AdapterError(
      "unavailable",
      undefined,
      `upload ${path}: ${e instanceof Error ? e.message : "network error"}`,
    );
  }

  let body: { data?: T; error?: { code?: string; message?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new AdapterError("unknown", undefined, `upload ${path}: non-JSON response (${res.status})`);
  }

  if (!res.ok || body.error) {
    const known: AdapterErrorCode[] = [
      "unauthenticated",
      "forbidden",
      "not_found",
      "invalid",
      "unavailable",
      "unknown",
    ];
    const code = known.includes(body.error?.code as AdapterErrorCode)
      ? (body.error?.code as AdapterErrorCode)
      : codeFromHttpStatus(res.status);
    throw new AdapterError(code, body.error?.message, `upload ${path} (${res.status})`);
  }
  return body.data as T;
}
