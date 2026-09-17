import { AdapterError, codeFromHttpStatus } from "@/adapters/errors";
import { parseRecordingAuthorityResponse, type RecordingAuthorityRequest } from "@/contracts/encounterRecordingAuthority";

/** No credentials or PHI persisted in browser storage; no fallback transport. */
export async function requestRecordingAuthority(request: RecordingAuthorityRequest, signal: AbortSignal) {
  try {
    const response = await fetch("/api/live/scribe/authority", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new AdapterError(response.status === 409 ? "conflict" : codeFromHttpStatus(response.status));
    return parseRecordingAuthorityResponse(request, await response.json());
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("unavailable");
  }
}
