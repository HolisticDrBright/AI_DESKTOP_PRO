import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { confirmRecoveryMeetingAbsent, confirmRecoveryReminderAbsent, recoveryAwait,
  type AppointmentRecoveryProviderDependencies } from "./appointment-provider-recovery";

const meeting = { id: "900000001", markers: ["Governed appointment request fictional"], start: "2026-11-10T17:00:00.000Z", uuid: "fictional-uuid" };
const reminder = { name: "alp-fictional-24h", organizationId: "fictional-org", requestId: "fictional-request", start: meeting.start, generation: "fictional-generation" };
const foundMeeting = () => ({ id: 900000001, agenda: meeting.markers[0], start_time: meeting.start, uuid: meeting.uuid, type: 2, status: "waiting", host_id: "fictional-host" });
const foundReminder = () => ({ Name: reminder.name, GroupName: "fictional-group", Target: { Arn: "fictional-target", RoleArn: "fictional-role", Input: JSON.stringify({
  internalEvent: "send_appointment_reminder", organizationId: reminder.organizationId, requestId: reminder.requestId, scheduledStart: reminder.start,
  reminderProtocol: "appointment-reminder/2", reminderGeneration: reminder.generation,
}) } });
const absent = () => new Response(JSON.stringify({ code: 3001 }), { status: 404 });
const missing = () => { throw Object.assign(new Error("fictional missing"), { name: "ResourceNotFoundException" }); };
let controller: AbortController;
let deps: AppointmentRecoveryProviderDependencies;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
let read: ReturnType<typeof vi.fn<AppointmentRecoveryProviderDependencies["schedulerRead"]>>;
let remove: ReturnType<typeof vi.fn<AppointmentRecoveryProviderDependencies["schedulerDelete"]>>;
let guard: ReturnType<typeof vi.fn<AppointmentRecoveryProviderDependencies["beforeWrite"]>>;
beforeEach(() => {
  controller = new AbortController(); transport = vi.fn<typeof fetch>().mockResolvedValue(absent()); read = vi.fn<AppointmentRecoveryProviderDependencies["schedulerRead"]>().mockImplementation(missing);
  remove = vi.fn<AppointmentRecoveryProviderDependencies["schedulerDelete"]>().mockResolvedValue({}); guard = vi.fn<AppointmentRecoveryProviderDependencies["beforeWrite"]>().mockResolvedValue(undefined);
  deps = { signal: controller.signal, fetch: transport, zoomCredentials: vi.fn().mockResolvedValue({ accessToken: "fictional-token", userId: "fictional-host" }),
    beforeWrite: guard, schedulerRead: read, schedulerDelete: remove, scheduleGroup: "fictional-group", scheduleTarget: "fictional-target", scheduleRole: "fictional-role" };
});
afterEach(() => controller.abort());

it("accepts only exact Zoom absence and makes no write", async () => {
  await confirmRecoveryMeetingAbsent(meeting, deps);
  expect(transport).toHaveBeenCalledTimes(1); expect(guard).not.toHaveBeenCalled();
  expect(transport.mock.calls[0][0]).toBe("https://api.zoom.us/v2/meetings/900000001");
  expect(transport.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
});
it("removes a bound waiting meeting only after the writer guard and confirms absence", async () => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify(foundMeeting()))).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(absent());
  await confirmRecoveryMeetingAbsent(meeting, deps);
  expect(transport.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "DELETE", "GET"]);
  expect(guard).toHaveBeenCalledTimes(1);
  expect(guard.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[1]);
});
it.each([
  { id: 900000002 }, { agenda: "foreign" }, { start_time: "2026-11-11T17:00:00.000Z" }, { host_id: "foreign-host" },
  { uuid: "foreign-uuid" }, { type: 8 }, { type: 3 }, { type: 1 }, { status: "started" },
])("refuses mismatched or live Zoom resources without deleting: %j", async patch => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...foundMeeting(), ...patch })));
  await expect(confirmRecoveryMeetingAbsent(meeting, deps)).rejects.toThrow("appointment_provider_recovery_unconfirmed");
  expect(transport).toHaveBeenCalledTimes(1); expect(guard).not.toHaveBeenCalled();
});
it.each([400, 401, 403, 404, 429, 500])("does not interpret HTTP %s as absence without exact code", async status => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ code: status === 404 ? "3001" : 3001 }), { status }));
  await expect(confirmRecoveryMeetingAbsent(meeting, deps)).rejects.toThrow(); expect(guard).not.toHaveBeenCalled();
});
it.each(["not-json", "[]", "null", "x".repeat(65537)])("refuses malformed or excessive provider bodies", async body => {
  transport.mockResolvedValueOnce(new Response(body, { status: 404 }));
  await expect(confirmRecoveryMeetingAbsent(meeting, deps)).rejects.toThrow(); expect(guard).not.toHaveBeenCalled();
});
it("does not certify a successful deletion while GET still finds the meeting", async () => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify(foundMeeting()))).mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(foundMeeting())));
  await expect(confirmRecoveryMeetingAbsent(meeting, deps)).rejects.toThrow();
});
it("refuses the write when the conditional writer guard is lost", async () => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify(foundMeeting()))); guard.mockRejectedValue(new Error("fictional competing writer"));
  await expect(confirmRecoveryMeetingAbsent(meeting, deps)).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(1);
});
it("accepts an explicit host email but refuses the unbound me alias", async () => {
  deps.zoomCredentials = vi.fn().mockResolvedValue({ accessToken: "fictional-token", userId: "Host@example.test" });
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...foundMeeting(), host_email: "host@example.test" })))
    .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(absent());
  await confirmRecoveryMeetingAbsent(meeting, deps);
  deps.zoomCredentials = vi.fn().mockResolvedValue({ accessToken: "fictional-token", userId: "me" });
  await expect(confirmRecoveryMeetingAbsent(meeting, deps)).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(3);
});
it("scheduler exact not-found is read-only", async () => {
  await confirmRecoveryReminderAbsent(reminder, deps); expect(read).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
});
it("confirms scheduler absence after a bound deletion", async () => {
  read.mockResolvedValueOnce(foundReminder()); await confirmRecoveryReminderAbsent(reminder, deps);
  expect(remove).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2); expect(remove.mock.calls[0][0]).toBe(reminder.name);
});
it.each(["AccessDeniedException", "ThrottlingException", "InternalServerException", "NotFound"])("scheduler %s is not proof of absence", async name => {
  read.mockRejectedValueOnce(Object.assign(new Error("fictional"), { name }));
  await expect(confirmRecoveryReminderAbsent(reminder, deps)).rejects.toThrow(); expect(remove).not.toHaveBeenCalled();
});
it.each(["Name", "GroupName", "Arn", "RoleArn", "organizationId", "requestId", "scheduledStart", "reminderGeneration", "reminderProtocol", "internalEvent"])("refuses foreign scheduler %s", async field => {
  const value = foundReminder();
  if (field === "Name" || field === "GroupName") value[field] = "foreign";
  else if (field === "Arn" || field === "RoleArn") value.Target[field] = "foreign";
  else value.Target.Input = JSON.stringify({ ...JSON.parse(value.Target.Input), [field]: "foreign" });
  read.mockResolvedValueOnce(value); await expect(confirmRecoveryReminderAbsent(reminder, deps)).rejects.toThrow(); expect(remove).not.toHaveBeenCalled();
});
it("legacy generation cannot delete a newer schedule", async () => {
  read.mockResolvedValueOnce(foundReminder()); await expect(confirmRecoveryReminderAbsent({ ...reminder, generation: undefined }, deps)).rejects.toThrow();
  expect(remove).not.toHaveBeenCalled();
});
it("scheduler failed removal and post-read denial remain unresolved", async () => {
  read.mockResolvedValueOnce(foundReminder()); remove.mockRejectedValueOnce(new Error("fictional denial"));
  await expect(confirmRecoveryReminderAbsent(reminder, deps)).rejects.toThrow();
  read.mockResolvedValueOnce(foundReminder()).mockRejectedValueOnce(new Error("fictional denial"));
  await expect(confirmRecoveryReminderAbsent(reminder, deps)).rejects.toThrow();
});
it.each(["credentials", "headers", "body", "scheduler", "writer"])("aborting stalled %s does not continue to another write", async stage => {
  let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; });
  const hang = () => { reached(); return new Promise<never>(() => {}); };
  if (stage === "credentials") deps.zoomCredentials = hang;
  if (stage === "headers") transport.mockImplementation(hang);
  if (stage === "body") transport.mockResolvedValueOnce(new Response(new ReadableStream({ start() { reached(); } })));
  if (stage === "scheduler") read.mockImplementation(hang);
  if (stage === "writer") { transport.mockResolvedValueOnce(new Response(JSON.stringify(foundMeeting()))); guard.mockImplementation(hang); }
  const result = stage === "scheduler" ? confirmRecoveryReminderAbsent(reminder, deps) : confirmRecoveryMeetingAbsent(meeting, deps);
  const assertion = expect(result).rejects.toThrow("appointment_provider_recovery_unconfirmed");
  await started; controller.abort(); await assertion;
  expect(remove).not.toHaveBeenCalled(); expect(transport.mock.calls.some(call => call[1]?.method === "DELETE")).toBe(false);
});
it("already aborted recovery never starts work", async () => {
  controller.abort(); const work = vi.fn(); await expect(recoveryAwait(controller.signal, work)).rejects.toThrow(); expect(work).not.toHaveBeenCalled();
});
it("a stalled SDK read also reaches the configured child deadline without a manual abort", async () => {
  read.mockImplementation(() => new Promise(() => {}));
  await expect(confirmRecoveryReminderAbsent(reminder, deps)).rejects.toThrow("appointment_provider_recovery_unconfirmed");
  expect(remove).not.toHaveBeenCalled();
}, 8000);
