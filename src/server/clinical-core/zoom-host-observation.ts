if (typeof window !== "undefined") throw new Error("Zoom host observation is server-only");
import { boundedProviderJson } from "./bounded-provider-json";

export class ZoomHostObservationRefused extends Error {
  constructor() { super("zoom_host_observation_refused"); }
}

export type ZoomSdkHostInput = Readonly<{
  accessToken: string; accountId: string; configuredUserId: string;
  meetingId: string; meetingUuid: string | null; passcode: string | null;
}>;

const refuse = () => new ZoomHostObservationRefused();
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse();
  return value as Record<string, unknown>;
};
const opaqueId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{2,128}$/.test(value) || value.toLowerCase() === "me") throw refuse();
  return value;
};
const validUuid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
  && !/[\s\u0000-\u001f\u007f]/.test(value) && Buffer.from(value, "utf8").toString("utf8") === value;
const validPassword = (value: unknown): value is string => typeof value === "string" && value.length <= 64
  && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value, "utf8").toString("utf8") === value;

/** This is a fresh provider observation, not practitioner/clinic authority or
 * a retained credential release. Never derive a host from display names,
 * caller-supplied email, an SDK key, or the meeting number alone. */
export function validateZoomSdkHost(profileValue: unknown, meetingValue: unknown, input: ZoomSdkHostInput): string {
  if (typeof input.meetingId !== "string" || !/^\d{9,12}$/.test(input.meetingId) || !validUuid(input.meetingUuid) || !validPassword(input.passcode)) throw refuse();
  const profile = record(profileValue), meeting = record(meetingValue);
  const hostId = opaqueId(profile.id);
  if (opaqueId(profile.account_id) !== input.accountId || profile.status !== "active") throw refuse();
  if (input.configuredUserId.includes("@")) {
    if (typeof profile.email !== "string" || profile.email.toLowerCase() !== input.configuredUserId.toLowerCase()) throw refuse();
  } else if (hostId !== input.configuredUserId) throw refuse();
  const meetingId = typeof meeting.id === "number" && Number.isSafeInteger(meeting.id) ? String(meeting.id) : meeting.id;
  if (meetingId !== input.meetingId || meeting.host_id !== hostId || meeting.uuid !== input.meetingUuid || meeting.type !== 2
    || (meeting.status !== "waiting" && meeting.status !== "started")) throw refuse();
  // The provider omits the password for an unprotected meeting. Do not
  // coerce arrays/objects or confuse the join URL's encrypted pwd with it.
  const password = meeting.password === undefined || meeting.password === null ? "" : meeting.password;
  if (!validPassword(password) || password !== input.passcode) throw refuse();
  return hostId;
}

/** Fixed Zoom origin, bounded JSON, no redirects, one shared caller deadline.
 * The canonical observed host ID is the only identity suitable for ZAK. */
export async function observeZoomSdkHost(input: ZoomSdkHostInput, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  try {
    if (signal.aborted || typeof input.meetingId !== "string" || !/^\d{9,12}$/.test(input.meetingId) || !validUuid(input.meetingUuid) || !validPassword(input.passcode)
      || typeof input.configuredUserId !== "string" || !input.configuredUserId || input.configuredUserId.toLowerCase() === "me"
      || input.configuredUserId.length > 500 || /\s|[\u0000-\u001f\u007f]/.test(input.configuredUserId)
      || typeof input.accessToken !== "string" || input.accessToken.length < 2 || input.accessToken.length > 8192
      || !/^[A-Za-z0-9._~+/-]+=*$/.test(input.accessToken)) throw refuse();
    const read = async (path: string) => {
      const response = await fetcher(`https://api.zoom.us/v2/${path}`, { method: "GET", redirect: "manual", cache: "no-store", signal,
        headers: { authorization: `Bearer ${input.accessToken}` } });
      if (!response.ok || response.status !== 200 || response.redirected) {
        try { await response.body?.cancel(); } catch { /* refusal retained */ }
        throw refuse();
      }
      const value = await boundedProviderJson(response, 65_536);
      if (signal.aborted) throw refuse();
      return value;
    };
    const profile = await read(`users/${encodeURIComponent(input.configuredUserId)}`);
    // Refuse an invalid profile before querying a potentially unrelated
    // meeting. Do not trust the configured email as a canonical Zoom ID.
    const host = record(profile);
    const hostId = opaqueId(host.id);
    if (opaqueId(host.account_id) !== input.accountId || host.status !== "active"
      || (input.configuredUserId.includes("@") ? typeof host.email !== "string" || host.email.toLowerCase() !== input.configuredUserId.toLowerCase()
        : hostId !== input.configuredUserId)) throw refuse();
    const meeting = await read(`meetings/${input.meetingId}`);
    return validateZoomSdkHost(profile, meeting, input);
  } catch { throw refuse(); }
}
