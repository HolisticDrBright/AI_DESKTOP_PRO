import { boundedProviderJson } from "./bounded-provider-json";

export class AppointmentProviderRecoveryError extends Error {
  constructor() { super("appointment_provider_recovery_unconfirmed"); }
}
type JsonObject = Record<string, unknown>;
export type RecoveryMeeting = { id: string; markers: string[]; start: string; uuid?: string | null };
export type RecoveryReminder = { name: string; organizationId: string; requestId: string; start: string; generation?: string };
export type AppointmentRecoveryProviderDependencies = {
  signal: AbortSignal; fetch: typeof fetch;
  zoomCredentials: (signal: AbortSignal) => Promise<{ accessToken: string; userId: string }>;
  beforeWrite: () => Promise<void>;
  schedulerRead: (name: string, signal: AbortSignal) => Promise<JsonObject>;
  schedulerDelete: (name: string, signal: AbortSignal) => Promise<unknown>;
  scheduleGroup: string; scheduleTarget: string; scheduleRole: string;
};

/** Bounds local waiting, not remote cancellation. A rejected write may still
 * finish remotely; recovery touches only the same non-recurring resource. */
export function recoveryAwait<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new AppointmentProviderRecoveryError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new AppointmentProviderRecoveryError()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new AppointmentProviderRecoveryError(); return work(); })
      .then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(new AppointmentProviderRecoveryError()); else resolve(value); },
        () => { signal.removeEventListener("abort", abort); reject(new AppointmentProviderRecoveryError()); });
  });
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppointmentProviderRecoveryError();
  return value as JsonObject;
}
function signalFor(deps: AppointmentRecoveryProviderDependencies) { return AbortSignal.any([deps.signal, AbortSignal.timeout(5000)]); }
async function providerJson(response: Response, signal: AbortSignal): Promise<JsonObject> {
  return object(await recoveryAwait(signal, () => boundedProviderJson(response, 65536)));
}
function missingSchedule(error: unknown) {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "ResourceNotFoundException";
}

/** No upcoming listing, broad 404, recurrence deletion, provider credential in
 * the result, or inferred absence. Only GET of the exact id with code 3001
 * proves absence. A successful DELETE still needs that positive observation. */
export async function confirmRecoveryMeetingAbsent(meeting: RecoveryMeeting, deps: AppointmentRecoveryProviderDependencies): Promise<void> {
  if (!/^\d{9,12}$/.test(meeting.id) || !meeting.markers.length || meeting.markers.some(marker => !marker || marker.length > 256)
    || !Number.isFinite(Date.parse(meeting.start))) throw new AppointmentProviderRecoveryError();
  const credentialsSignal = signalFor(deps);
  const { accessToken, userId } = await recoveryAwait(credentialsSignal, () => deps.zoomCredentials(credentialsSignal));
  if (!accessToken || !userId || userId === "me") throw new AppointmentProviderRecoveryError();
  const url = `https://api.zoom.us/v2/meetings/${meeting.id}`;
  async function read(): Promise<JsonObject | null> {
    const signal = signalFor(deps), result = await recoveryAwait(signal, () => deps.fetch(url, {
      method: "GET", redirect: "error", cache: "no-store", signal, headers: { authorization: `Bearer ${accessToken}` },
    }));
    const payload = await providerJson(result, signal);
    if (result.status === 404 && payload.code === 3001) return null;
    if (result.status !== 200) throw new AppointmentProviderRecoveryError();
    return payload;
  }
  const current = await read();
  if (current === null) return;
  // Reject recurring/PMI/instant or live meetings. An opaque configured host id
  // matches host_id; an explicitly configured email matches host_email.
  const hostMatches = userId.includes("@") ? typeof current.host_email === "string" && current.host_email.toLowerCase() === userId.toLowerCase()
    : current.host_id === userId;
  if (String(current.id) !== meeting.id || current.type !== 2 || current.status !== "waiting" || !hostMatches
    || !meeting.markers.includes(String(current.agenda)) || typeof current.start_time !== "string"
    || Date.parse(current.start_time) !== Date.parse(meeting.start)
    || (meeting.uuid && current.uuid !== meeting.uuid)) throw new AppointmentProviderRecoveryError();
  await recoveryAwait(deps.signal, deps.beforeWrite);
  const signal = signalFor(deps), deleted = await recoveryAwait(signal, () => deps.fetch(url, {
    method: "DELETE", redirect: "error", cache: "no-store", signal, headers: { authorization: `Bearer ${accessToken}` },
  }));
  if (deleted.status !== 204) {
    const error = await providerJson(deleted, signal);
    if (deleted.status !== 404 || error.code !== 3001) throw new AppointmentProviderRecoveryError();
  }
  if (await read() !== null) throw new AppointmentProviderRecoveryError();
}

/** A scheduler denial/throttle/timeout is not absence. Only the named group's
 * exact bound target may be removed; a post-delete GetSchedule is mandatory. */
export async function confirmRecoveryReminderAbsent(reminder: RecoveryReminder, deps: AppointmentRecoveryProviderDependencies): Promise<void> {
  if (!/^alp-[A-Za-z0-9_-]{1,60}$/.test(reminder.name) || !deps.scheduleGroup || !deps.scheduleTarget || !deps.scheduleRole)
    throw new AppointmentProviderRecoveryError();
  async function read(): Promise<JsonObject | null> {
    const signal = signalFor(deps);
    // Preserve the SDK exception type before recoveryAwait sanitizes errors.
    return recoveryAwait(signal, async () => {
      try { return await deps.schedulerRead(reminder.name, signal); }
      catch (error) { if (missingSchedule(error)) return null; throw error; }
    });
  }
  const current = await read(); if (current === null) return;
  const target = object(current.Target);
  if (current.Name !== reminder.name || current.GroupName !== deps.scheduleGroup
    || target.Arn !== deps.scheduleTarget || target.RoleArn !== deps.scheduleRole
    || typeof target.Input !== "string" || Buffer.byteLength(target.Input) > 16384) throw new AppointmentProviderRecoveryError();
  let input: JsonObject;
  try { input = object(JSON.parse(target.Input)); } catch { throw new AppointmentProviderRecoveryError(); }
  if (input.internalEvent !== "send_appointment_reminder" || input.organizationId !== reminder.organizationId
    || input.requestId !== reminder.requestId || input.scheduledStart !== reminder.start
    || (reminder.generation === undefined ? input.reminderProtocol !== undefined || input.reminderGeneration !== undefined
      : input.reminderProtocol !== "appointment-reminder/2" || input.reminderGeneration !== reminder.generation)) throw new AppointmentProviderRecoveryError();
  await recoveryAwait(deps.signal, deps.beforeWrite);
  const signal = signalFor(deps);
  await recoveryAwait(signal, async () => {
    try { return await deps.schedulerDelete(reminder.name, signal); }
    catch (error) { if (missingSchedule(error)) return; throw error; }
  });
  if (await read() !== null) throw new AppointmentProviderRecoveryError();
}
