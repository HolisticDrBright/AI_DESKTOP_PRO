if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { AdapterError, codeFromHttpStatus } from "./errors";

interface PostgrestError {
  code?: string;
}

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
    const code =
      response.status === 409 || serverCode === "55000" || serverCode === "40001"
        ? "conflict"
        : codeFromHttpStatus(response.status);
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
