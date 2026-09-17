import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const session = vi.hoisted(() => vi.fn());
vi.mock("@/server/session", () => ({ getRequestSession: session }));
vi.mock("@/adapters/mode", () => ({ USE_LIVE_API: true }));
import { POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const request = { action: "workspace", encounterId: id, locale: "en-US", jurisdiction: "US-CA" };
const workspace = { encounterId: id, encounterStatus: "in_progress", participants: [], consentReleases: [], activeCapture: null };
const capabilities = { consentManagement: true, audioCapture: false, reason: "audio_transport_not_configured" };
const upstream = vi.fn();
function req(data: unknown = request, headers: Record<string, string> = {}) {
  return new Request("https://desktop.example/api/live/scribe/authority", { method: "POST",
    headers: { origin: "https://desktop.example", "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", upstream);
  vi.stubEnv("RECORDING_AWS_API_ORIGIN", "https://abcdefghij.execute-api.us-east-2.amazonaws.com");
  session.mockResolvedValue({ signedIn: true, token: "fictional-cookie-id-token" });
  upstream.mockImplementation(async () => Response.json({ data: workspace, capabilities }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
it("uses the cookie token, exact separate AWS route, bounded no-cache/redirect transport, and strict response", async () => {
  const response = await POST(req(request, { authorization: "Bearer browser-override" }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ data: workspace, capabilities });
  expect(upstream).toHaveBeenCalledOnce();
  expect(upstream.mock.calls[0][0]).toBe("https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/encounter-recording/authority");
  expect(upstream.mock.calls[0][1]).toMatchObject({ method: "POST", cache: "no-store", redirect: "error",
    headers: { Authorization: "Bearer fictional-cookie-id-token" }, body: JSON.stringify(request) });
  expect(upstream.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
it.each<Record<string, string>>([{ origin: "https://evil.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }])
  ("rejects cross-origin writes before reading identity or contacting AWS: %o", async headers => {
    expect((await POST(req(request, headers))).status).toBe(403);
    expect(session).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });
it("requires the real cookie session with no demo identity fallback", async () => {
  session.mockResolvedValue({ signedIn: false, token: null });
  expect((await POST(req())).status).toBe(401); expect(upstream).not.toHaveBeenCalled();
});
it.each(["", "http://abcdefghij.execute-api.us-east-2.amazonaws.com", "https://user@abcdefghij.execute-api.us-east-2.amazonaws.com",
  "https://abcdefghij.execute-api.us-east-2.amazonaws.com:8443", "https://evil.example", "https://abcdefghij.execute-api.us-east-2.amazonaws.com/override"])
  ("refuses misconfigured destinations without fallback: %s", async value => {
    vi.stubEnv("RECORDING_AWS_API_ORIGIN", value);
    expect((await POST(req())).status).toBe(503); expect(upstream).not.toHaveBeenCalled();
  });
it.each([{ ...request, actorPersonId: other }, { ...request, action: "beginCapture" },
  { action: "grantConsent", participantId: id, releaseId: other, commandId: id, method: "written", acknowledgment: "yes", representative: { basis: "parent" } }])
  ("refuses identity, capture and free-text representative bypasses: %o", async value => {
    expect((await POST(req(value))).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
it.each([400, 401, 403, 409, 503])("maps %s without disclosing upstream text", async status => {
  upstream.mockResolvedValue(new Response("secret-token patient email sql", { status }));
  const response = await POST(req()); expect(response.status).toBe(status);
  expect(await response.text()).not.toMatch(/secret-token|patient email|sql/);
});
it.each([
  { data: { ...workspace, encounterId: other }, capabilities },
  { data: { ...workspace, captureToken: "secret" }, capabilities },
  { data: workspace, capabilities: { ...capabilities, audioCapture: true } },
])("rejects cross-encounter, secret-bearing and unimplemented capture responses", async payload => {
  upstream.mockResolvedValue(Response.json(payload));
  expect((await POST(req())).status).toBe(503);
});
it("checks exact consent document content against its hash before display", async () => {
  const content = "Fictional reviewed recording document.";
  const data = { id: other, scope: "recording", version: "v1", locale: "en-US", jurisdiction: "US-CA",
    content, contentSha256: createHash("sha256").update(content).digest("hex") };
  upstream.mockImplementation(async () => Response.json({ data, capabilities }));
  const input = { action: "readConsentRelease", encounterId: id, releaseId: other };
  expect((await POST(req(input))).status).toBe(200);
  data.content = "Changed unreviewed text";
  expect((await POST(req(input))).status).toBe(503);
});
it("bounds request and response bodies and rejects malformed UTF-8", async () => {
  expect((await POST(req({ ...request, large: "a".repeat(10000) }))).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  upstream.mockResolvedValue(new Response("a".repeat(256001), { headers: { "content-type": "application/json" } }));
  expect((await POST(req())).status).toBe(503);
  const bad = new Request("https://desktop.example/api/live/scribe/authority", { method: "POST",
    headers: { origin: "https://desktop.example", "content-type": "application/json" }, body: new Uint8Array([0xff]) });
  expect((await POST(bad)).status).toBe(400);
});
it("bounds a stalled upstream body and cancels it without returning partial content", async () => {
  vi.useFakeTimers(); const cancel = vi.fn();
  upstream.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
  const pending = POST(req()); await vi.advanceTimersByTimeAsync(10001);
  expect((await pending).status).toBe(503); expect(cancel).toHaveBeenCalledOnce();
});
