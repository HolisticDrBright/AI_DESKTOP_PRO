if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import {
  AdapterError,
  codeFromHttpStatus,
  type AdapterErrorCode,
} from "./errors";

interface PostgrestError {
  code?: string;
  /** Present on PostgREST errors and on the RPC refusals we author ourselves. */
  message?: string;
}

function mapPostgrestError(status: number, serverCode?: string): AdapterErrorCode {
  switch (serverCode) {
    case "28000":
    case "PGRST301":
      return "unauthenticated";
    case "42501":
      return "forbidden";
    case "P0002":
    case "PGRST116":
      return "not_found";
    case "22023":
    case "22P02":
    case "23502":
      return "invalid";
    case "23505":
    case "40001":
    case "40003":
    case "55000":
      return "conflict";
    default:
      return status === 409 ? "conflict" : codeFromHttpStatus(status);
  }
}

/*
 * WHY DATABASE MESSAGES ARE NOT PASSED THROUGH.
 *
 * The governed RPCs raise carefully worded refusals ("these items carry a dose
 * with no recorded source: Magnesium ..."), and it is tempting to surface them
 * verbatim so the operator learns WHICH item. That was tried and reverted: a
 * message is an unstructured channel, and this boundary cannot tell an
 * authored refusal from a Postgres internal that happens to share a SQLSTATE
 * and carries constraint names or the conflicting VALUES with it. There is an
 * existing safety test asserting exactly this, and it is right.
 *
 * The actionable detail reaches the operator through a STRUCTURED read
 * instead: `get_protocol_template_detail` returns `unsourcedDoseCount` and the
 * items themselves, each marked with whether its dose names a source, and the
 * template surface renders that. The refusal stays opaque; the explanation
 * comes from data that was designed to be shown.
 */

function clinicalConfig() {
  const url = process.env.CLINICAL_SUPABASE_URL;
  const anon = process.env.CLINICAL_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new AdapterError(
      "unavailable",
      "The clinical database is not configured on this deployment.",
      "CLINICAL_SUPABASE_URL / CLINICAL_SUPABASE_ANON_KEY missing",
    );
  }
  return { url: url.replace(/\/$/, ""), anon };
}

async function request<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    token?: string | null;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  if (!options.token) throw new AdapterError("unauthenticated");
  const { url, anon } = clinicalConfig();
  const method = options.method ?? "GET";

  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: anon,
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
        "Accept-Profile": "public",
        ...(options.body
          ? { "Content-Type": "application/json", "Content-Profile": "public" }
          : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch (error) {
    throw new AdapterError(
      "unavailable",
      undefined,
      `clinical Supabase fetch: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  let payload: unknown;
  try {
    payload = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new AdapterError(
      "unknown",
      undefined,
      `clinical Supabase returned non-JSON (${response.status})`,
    );
  }

  if (!response.ok) {
    const serverCode =
      payload && typeof payload === "object" ? (payload as PostgrestError).code : undefined;
    const code = mapPostgrestError(response.status, serverCode);
    throw new AdapterError(code, undefined, `PostgREST ${response.status} ${serverCode ?? ""}`.trim());
  }

  return payload as T;
}

export function clinicalSelect<T>(
  table: string,
  params: URLSearchParams,
  token?: string | null,
) {
  return request<T>(`${table}?${params.toString()}`, { token });
}

export function clinicalRpc<T>(
  functionName: string,
  args: Record<string, unknown>,
  token?: string | null,
) {
  return request<T>(`rpc/${functionName}`, {
    method: "POST",
    token,
    body: args,
  });
}
