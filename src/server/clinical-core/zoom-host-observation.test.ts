import { describe, expect, it, vi } from "vitest";
import { observeZoomSdkHost, validateZoomSdkHost, ZoomHostObservationRefused, type ZoomSdkHostInput } from "./zoom-host-observation";

const input: ZoomSdkHostInput = { accessToken: "fictional-access", accountId: "account-one", configuredUserId: "host@example.test",
  meetingId: "900000001", meetingUuid: "opaque/meeting+uuid==", passcode: "meeting-pass" };
const profile = { id: "canonical-host", account_id: input.accountId, email: input.configuredUserId, status: "active" };
const meeting = { id: 900000001, uuid: input.meetingUuid, host_id: profile.id, type: 2, status: "waiting", password: input.passcode };
const signal = () => AbortSignal.timeout(5000);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Zoom SDK host observations", () => {
  it("binds an email alias to the provider's canonical active host and matching account/instance", () => {
    expect(validateZoomSdkHost(profile, meeting, input)).toBe(profile.id);
    expect(validateZoomSdkHost({ ...profile, email: "HOST@EXAMPLE.TEST" }, meeting, input)).toBe(profile.id);
    expect(validateZoomSdkHost(profile, { ...meeting, status: "started", id: "900000001" }, input)).toBe(profile.id);
  });
  it("binds an opaque configured host only by exact canonical ID, without requiring profile email", () => {
    expect(validateZoomSdkHost({ ...profile, email: undefined }, meeting, { ...input, configuredUserId: profile.id })).toBe(profile.id);
    expect(() => validateZoomSdkHost(profile, meeting, { ...input, configuredUserId: "CANONICAL-HOST" })).toThrow(ZoomHostObservationRefused);
  });
  it("never treats an alias returned as both profile ID and meeting host as a canonical identity", () => {
    expect(() => validateZoomSdkHost({ ...profile, id: "me" }, { ...meeting, host_id: "me" }, input)).toThrow(ZoomHostObservationRefused);
  });
  it.each([null, [], "profile", { ...profile, id: [] }, { ...profile, id: "me" }, { ...profile, id: "host/id" },
    { ...profile, account_id: "account-two" }, { ...profile, account_id: null }, { ...profile, email: null },
    { ...profile, email: "other@example.test" }, { ...profile, status: "pending" }, { ...profile, status: "inactive" }])("refuses unusable or different host profiles %j", value => {
    expect(() => validateZoomSdkHost(value, meeting, input)).toThrow(ZoomHostObservationRefused);
  });
  it.each([null, [], "meeting", { ...meeting, id: "900-000-001" }, { ...meeting, id: 900000001.1 },
    { ...meeting, id: "900000002" }, { ...meeting, uuid: null }, { ...meeting, uuid: "new-instance" },
    { ...meeting, host_id: "other-host" }, { ...meeting, host_id: null }, { ...meeting, type: 1 }, { ...meeting, type: 8 },
    { ...meeting, status: ["waiting"] }, { ...meeting, status: "ended" }, { ...meeting, password: ["meeting-pass"] },
    { ...meeting, password: "changed" }, { ...meeting, password: "meeting-pass\u0000" }])("refuses wrong or malformed meetings %j", value => {
    expect(() => validateZoomSdkHost(profile, value, input)).toThrow(ZoomHostObservationRefused);
  });
  it.each([{ meetingUuid: null }, { meetingUuid: "" }, { meetingUuid: "invalid\ud800" }, { meetingUuid: "x".repeat(513) },
    { meetingId: "900-000-001" }, { passcode: null }, { passcode: "x".repeat(65) }, { passcode: "bad\u0000" }])("refuses unproven saved bindings %j", mismatch => {
    expect(() => validateZoomSdkHost(profile, meeting, { ...input, ...mismatch })).toThrow(ZoomHostObservationRefused);
  });
  it("accepts a genuinely password-free meeting only when its saved password is explicitly empty", () => {
    expect(validateZoomSdkHost(profile, { ...meeting, password: undefined }, { ...input, passcode: "" })).toBe(profile.id);
    expect(validateZoomSdkHost(profile, { ...meeting, password: null }, { ...input, passcode: "" })).toBe(profile.id);
  });
  it("reads only fixed-origin GETs under the same abort signal with redirects and caches disabled", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(profile)).mockResolvedValueOnce(response(meeting));
    const deadline = signal();
    expect(await observeZoomSdkHost(input, deadline, fetcher)).toBe(profile.id);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["https://api.zoom.us/v2/users/host%40example.test", "https://api.zoom.us/v2/meetings/900000001"]);
    for (const [, options] of fetcher.mock.calls) expect(options).toEqual({ method: "GET", redirect: "manual", cache: "no-store", signal: deadline,
      headers: { authorization: "Bearer fictional-access" } });
  });
  it.each(["profile", "meeting"] as const)("refuses redirects at %s and cancels the unread body", async stage => {
    const bad = response({ token: "must-not-leak" });
    Object.defineProperty(bad, "redirected", { value: true });
    const cancel = vi.spyOn(bad.body!, "cancel");
    const fetcher = vi.fn<typeof fetch>();
    if (stage === "meeting") fetcher.mockResolvedValueOnce(response(profile));
    fetcher.mockResolvedValueOnce(bad);
    await expect(observeZoomSdkHost(input, signal(), fetcher)).rejects.toThrow("zoom_host_observation_refused");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(stage === "profile" ? 1 : 2);
  });
  it.each(["profile", "meeting"] as const)("refuses and cancels oversized actual %s bytes", async stage => {
    let cancelled = false;
    const bad = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(65_537))); },
      cancel() { cancelled = true; } }));
    const fetcher = vi.fn<typeof fetch>();
    if (stage === "meeting") fetcher.mockResolvedValueOnce(response(profile));
    fetcher.mockResolvedValueOnce(bad);
    await expect(observeZoomSdkHost(input, signal(), fetcher)).rejects.toThrow(ZoomHostObservationRefused);
    expect(cancelled).toBe(true);
  });
  it.each([401, 403, 404, 429, 500])("treats profile status %i as a refusal, not missing host permission to continue", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: profile.id }, status));
    await expect(observeZoomSdkHost(input, signal(), fetcher)).rejects.toThrow(ZoomHostObservationRefused);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses a wrong account before reading the meeting", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...profile, account_id: "other-account" }));
    await expect(observeZoomSdkHost(input, signal(), fetcher)).rejects.toThrow(ZoomHostObservationRefused);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses missing instance evidence before provider access", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(observeZoomSdkHost({ ...input, meetingUuid: null }, signal(), fetcher)).rejects.toThrow(ZoomHostObservationRefused);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ configuredUserId: "me" }, { configuredUserId: "host\r\n" }, { accessToken: "a\r\nb" }])("refuses invalid input before provider access %j", async mismatch => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(observeZoomSdkHost({ ...input, ...mismatch }, signal(), fetcher)).rejects.toThrow(ZoomHostObservationRefused);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses an already-aborted request before transport", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(observeZoomSdkHost(input, AbortSignal.abort(), fetcher)).rejects.toThrow(ZoomHostObservationRefused);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses a response returned after deadline even when a transport ignores cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return response(profile); });
    await expect(observeZoomSdkHost(input, controller.signal, fetcher)).rejects.toThrow(ZoomHostObservationRefused);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never exposes provider payload or transport errors in the refusal", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("fictional-access profile/health-payload"));
    await expect(observeZoomSdkHost(input, signal(), fetcher)).rejects.toThrow(/^zoom_host_observation_refused$/);
  });
});
