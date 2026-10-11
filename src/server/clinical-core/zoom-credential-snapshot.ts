if (typeof window !== "undefined") throw new Error("zoom credentials are server-only");
import { AsyncLocalStorage } from "node:async_hooks";

export class ZoomCredentialRefused extends Error {
  constructor() { super("zoom_credentials_refused"); }
}

export type ZoomCredentialSnapshot = Readonly<{
  accountId: string; clientId: string; clientSecret: string; userId: string;
  sdkKey: string | null; sdkSecret: string | null;
}>;

type RequestCustody = { closed: boolean; snapshots: Map<string, Promise<string>> };
const requestCustody = new AsyncLocalStorage<RequestCustody>();

/** A request-local lifetime, never a shared Lambda credential cache. Closing
 * it also refuses escaped continuations; a failed read is kept as a refusal,
 * not repeated against possibly rotated credentials in the same request. */
export function runZoomCredentialRequest<T>(work: () => Promise<T>): Promise<T> {
  const custody: RequestCustody = { closed: false, snapshots: new Map() };
  return requestCustody.run(custody, async () => {
    try { return await work(); }
    finally { custody.closed = true; custody.snapshots.clear(); }
  });
}

export async function zoomCredentialsForRequest(secretArn: string, load: () => Promise<unknown>, sdkRequired = false): Promise<ZoomCredentialSnapshot> {
  const custody = requestCustody.getStore();
  if (!custody || custody.closed || typeof secretArn !== "string" || !secretArn) throw new ZoomCredentialRefused();
  let snapshot = custody.snapshots.get(secretArn);
  if (!snapshot) {
    // Publish the promise before the first external read, including parallel
    // callers. Keep raw bounded bytes privately so a later SDK operation can
    // require its fields without fetching a different secret version.
    snapshot = Promise.resolve().then(() => {
      if (custody.closed) throw new ZoomCredentialRefused();
      return load();
    }).then(value => {
      parseZoomCredentialSnapshot(value);
      return value as string;
    }).catch(() => { throw new ZoomCredentialRefused(); });
    custody.snapshots.set(secretArn, snapshot);
  }
  const value = await snapshot;
  if (custody.closed) throw new ZoomCredentialRefused();
  return parseZoomCredentialSnapshot(value, sdkRequired);
}

/** Parse one Secrets Manager value, not a merged set of separate reads. This
 * is credential consistency, not clinic authority, a provider review, or a
 * retained secret-version binding. No credential values enter errors. */
export function parseZoomCredentialSnapshot(secretString: unknown, sdkRequired = false): ZoomCredentialSnapshot {
  if (typeof secretString !== "string" || Buffer.byteLength(secretString, "utf8") > 16_384
    || Buffer.from(secretString, "utf8").toString("utf8") !== secretString) throw new ZoomCredentialRefused();
  let parsed: unknown;
  try { parsed = JSON.parse(secretString); } catch { throw new ZoomCredentialRefused(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ZoomCredentialRefused();
  const record = parsed as Record<string, unknown>;
  const field = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string" || value.length < 2 || value.length > 500 || /\s|[\u0000-\u001f\u007f]/.test(value)
      || Buffer.from(value, "utf8").toString("utf8") !== value) throw new ZoomCredentialRefused();
    return value;
  };
  const userId = field("userId");
  if (userId.toLowerCase() === "me") throw new ZoomCredentialRefused();
  return Object.freeze({ accountId: field("accountId"), clientId: field("clientId"), clientSecret: field("clientSecret"), userId,
    sdkKey: sdkRequired ? field("sdkKey") : null, sdkSecret: sdkRequired ? field("sdkSecret") : null });
}

/** OAuth and ZAK are opaque bearer credentials, not display fields. Use a
 * dedicated bound and the RFC 6750 bearer character set, never interpolation
 * of controls into an Authorization header or returning a coerced object. */
export function zoomBearerToken(payload: unknown, key: "access_token" | "token"): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ZoomCredentialRefused();
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length < 2 || value.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(value)) throw new ZoomCredentialRefused();
  return value;
}
