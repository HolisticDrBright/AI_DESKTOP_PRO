if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import {
  AdapterError,
  codeFromHttpStatus,
  type AdapterErrorCode,
} from "./errors";
import { getContractFixtureTransport } from "@/server/runtime/contractFixture";

interface ClinicalServiceError {
  code?: string;
  /** Present on PostgREST errors and on the RPC refusals we author ourselves. */
  message?: string;
}

function mapClinicalServiceError(status: number, serverCode?: string): AdapterErrorCode {
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

type ClinicalTransport =
  | { kind: "aws"; origin: string }
  | { kind: "local-contract"; origin: string; credential: string };

function clinicalConfig(): ClinicalTransport {
  const fixture = getContractFixtureTransport();
  if (fixture) return { kind: "local-contract", ...fixture };
  const raw = String(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN ?? "").trim();
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new AdapterError(
      "unavailable",
      "The AWS clinical data service is not configured on this deployment.",
      "CLINICAL_AWS_WORKFORCE_API_ORIGIN missing or invalid",
    );
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash
    || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
    throw new AdapterError("unavailable", "The AWS clinical data service is not configured on this deployment.");
  }
  return { kind: "aws", origin: url.origin };
}

async function request<T>(
  operation: { kind: "select"; table: string; query: string }
    | { kind: "rpc"; functionName: string; args: Record<string, unknown> },
  token?: string | null,
): Promise<T> {
  if (!token) throw new AdapterError("unauthenticated");
  const config = clinicalConfig();
  const localPath = operation.kind === "select"
    ? `${operation.table}?${operation.query}`
    : `rpc/${operation.functionName}`;
  const url = config.kind === "local-contract"
    ? `${config.origin}/rest/v1/${localPath}`
    : `${config.origin}/clinical-core/workforce/data-compatibility`;
  const method = config.kind === "aws" || operation.kind === "rpc" ? "POST" : "GET";
  const body = config.kind === "aws"
    ? operation
    : operation.kind === "rpc" ? operation.args : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(config.kind === "local-contract" ? { apikey: config.credential } : {}),
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(config.kind === "local-contract" ? { "Accept-Profile": "public" } : {}),
        ...(body
          ? {
              "Content-Type": "application/json",
              ...(config.kind === "local-contract" ? { "Content-Profile": "public" } : {}),
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (error) {
    throw new AdapterError(
      "unavailable",
      undefined,
      `AWS clinical fetch: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  let payload: unknown;
  try {
    payload = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new AdapterError(
      "unknown",
      undefined,
      `AWS clinical service returned non-JSON (${response.status})`,
    );
  }

  if (!response.ok) {
    const serverCode =
      payload && typeof payload === "object" ? (payload as ClinicalServiceError).code : undefined;
    const code = mapClinicalServiceError(response.status, serverCode);
    throw new AdapterError(code, undefined, `AWS clinical service ${response.status} ${serverCode ?? ""}`.trim());
  }

  if (config.kind === "aws") {
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new AdapterError("unknown", undefined, "AWS clinical response envelope invalid");
    }
    return (payload as { data: T }).data;
  }
  return payload as T;
}

export function clinicalSelect<T>(
  table: string,
  params: URLSearchParams,
  token?: string | null,
) {
  return request<T>({ kind: "select", table, query: params.toString() }, token);
}

export function clinicalRpc<T>(
  functionName: string,
  args: Record<string, unknown>,
  token?: string | null,
) {
  return request<T>({ kind: "rpc", functionName, args }, token);
}
