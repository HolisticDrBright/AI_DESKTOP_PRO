if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { TRPC_BASE_URL } from "./config";
import { getClinicalAccessToken } from "./session.server";

/**
 * Minimal, dependency-free tRPC HTTP client for the shared backend
 * (Item 6). Server-only. Calls a single (non-batched) query with the
 * superjson wire shape the backend expects, presenting the demo
 * practitioner's bearer token. The desktop reaches Postgres ONLY through
 * this backend — never directly.
 *
 * Kept intentionally tiny (no @trpc/client dependency) so the verified
 * desktop build is unchanged; the response `result.data.json` field is the
 * superjson-unwrapped value for the plain shapes these procedures return.
 */

interface TrpcError {
  error?: { json?: { message?: string; data?: { code?: string } } };
}

export async function trpcQuery<T>(path: string, input?: unknown): Promise<T> {
  const token = await getClinicalAccessToken();
  const url = new URL(`${TRPC_BASE_URL}/${path}`);
  if (input !== undefined) {
    // Transformer (superjson) input wire shape: { json: <value> }.
    url.searchParams.set("input", JSON.stringify({ json: input }));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const body = (await res.json()) as
    | { result?: { data?: { json?: T } } }
    | TrpcError;

  if (!res.ok || "error" in body) {
    const e = body as TrpcError;
    const code = e.error?.json?.data?.code ?? String(res.status);
    // Never include the response body (may carry PHI) in the thrown message.
    throw new Error(`tRPC ${path} failed (${code})`);
  }

  return (body as { result: { data: { json: T } } }).result.data.json;
}
