if (typeof window !== "undefined") throw new Error("Recording authority is server-only.");
import { createHash } from "node:crypto";
import { AdapterError, codeFromHttpStatus } from "./errors";
import { recordingAuthorityRequestSchema, parseRecordingAuthorityResponse } from "@/contracts/encounterRecordingAuthority";
import { readBoundedRequestBody } from "@/server/bounded-request-body";

/** Separate AWS authority endpoint; no compatibility RPC, retired backend or
 * fixture fallback. Identity is exclusively the request-scoped cookie session. */
export async function recordingAuthorityRequest(input: unknown, token: string | null, signal?: AbortSignal) {
  if (!token) throw new AdapterError("unauthenticated");
  const parsed = recordingAuthorityRequestSchema.safeParse(input);
  if (!parsed.success) throw new AdapterError("invalid");
  let origin: URL;
  try { origin = new URL(process.env.RECORDING_AWS_API_ORIGIN ?? ""); }
  catch { throw new AdapterError("unavailable"); }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash
    || origin.username || origin.password || origin.port
    || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname)) throw new AdapterError("unavailable");
  const deadline = AbortSignal.timeout(12000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(`${origin.origin}/clinical-core/workforce/encounter-recording/authority`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(parsed.data), cache: "no-store", redirect: "error", signal: requestSignal,
    });
    // Never return, log or parse an untrusted error message.
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AdapterError(response.status === 409 ? "conflict" : codeFromHttpStatus(response.status));
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new AdapterError("unavailable");
    const headers = new Headers(response.headers);
    // fetch decodes content encodings; a compressed length is not the decoded length.
    if (headers.has("content-encoding")) headers.delete("content-length");
    const bytes = await readBoundedRequestBody({ body: response.body, headers, signal: requestSignal }, 256000, 10000);
    const result = parseRecordingAuthorityResponse(parsed.data, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (parsed.data.action === "readConsentRelease" && "content" in result.data
      && createHash("sha256").update(result.data.content).digest("hex") !== result.data.contentSha256)
      throw new AdapterError("unavailable");
    return result;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("unavailable");
  }
}
