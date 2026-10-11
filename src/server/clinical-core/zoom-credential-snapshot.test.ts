import { describe, expect, it, vi } from "vitest";
import { parseZoomCredentialSnapshot, runZoomCredentialRequest, zoomCredentialsForRequest, zoomBearerToken } from "./zoom-credential-snapshot";

const credentials = { accountId: "fictional-account", clientId: "fictional-client", clientSecret: "fictional-secret", userId: "host@example.test", sdkKey: "fictional-sdk", sdkSecret: "fictional-sdk-secret" };

describe("Zoom credential snapshot", () => {
  it("shares one read across parallel REST and later SDK operations in a request", async () => {
    const load = vi.fn(async () => JSON.stringify(credentials));
    await runZoomCredentialRequest(async () => {
      const [a, b] = await Promise.all([zoomCredentialsForRequest("secret", load), zoomCredentialsForRequest("secret", load)]);
      expect(a).toEqual(b);
      expect(a.sdkKey).toBeNull();
      expect((await zoomCredentialsForRequest("secret", load, true)).sdkKey).toBe(credentials.sdkKey);
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
  it("isolates simultaneous requests and refreshes for the next request", async () => {
    const loadA = vi.fn(async () => JSON.stringify(credentials));
    const loadB = vi.fn(async () => JSON.stringify({ ...credentials, userId: "other@example.test" }));
    const [a, b] = await Promise.all([
      runZoomCredentialRequest(() => zoomCredentialsForRequest("same-secret", loadA)),
      runZoomCredentialRequest(() => zoomCredentialsForRequest("same-secret", loadB)),
    ]);
    expect(a.userId).toBe("host@example.test");
    expect(b.userId).toBe("other@example.test");
    expect((await runZoomCredentialRequest(() => zoomCredentialsForRequest("same-secret", loadB))).userId).toBe("other@example.test");
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(2);
  });
  it("does not cache a failed read as permission to reload rotated credentials", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("fictional read failed")).mockResolvedValue(JSON.stringify(credentials));
    await runZoomCredentialRequest(async () => {
      await expect(zoomCredentialsForRequest("secret", load)).rejects.toThrow(/^zoom_credentials_refused$/);
      await expect(zoomCredentialsForRequest("secret", load, true)).rejects.toThrow(/^zoom_credentials_refused$/);
      expect(load).toHaveBeenCalledTimes(1);
    });
    await expect(runZoomCredentialRequest(() => zoomCredentialsForRequest("secret", load))).resolves.toMatchObject({ userId: credentials.userId });
  });
  it("refuses unscoped and escaped work without fetching a secret", async () => {
    const load = vi.fn(async () => JSON.stringify(credentials));
    await expect(zoomCredentialsForRequest("secret", load)).rejects.toThrow("zoom_credentials_refused");
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let late!: Promise<unknown>;
    await runZoomCredentialRequest(async () => { late = wait.then(() => zoomCredentialsForRequest("secret", load)); });
    release();
    await expect(late).rejects.toThrow("zoom_credentials_refused");
    expect(load).not.toHaveBeenCalled();
  });
  it("takes every SDK and OAuth value from one immutable snapshot", () => {
    const supplied = { ...credentials };
    const parsed = parseZoomCredentialSnapshot(JSON.stringify(supplied), true);
    expect(parsed).toEqual(credentials);
    expect(Object.isFrozen(parsed)).toBe(true);
    supplied.sdkKey = "different-sdk";
    expect(parsed.sdkKey).toBe("fictional-sdk");
  });
  it("does not require SDK credentials for a REST-only operation", () => {
    const { sdkKey: _key, sdkSecret: _secret, ...rest } = credentials;
    expect(parseZoomCredentialSnapshot(JSON.stringify(rest))).toEqual({ ...rest, sdkKey: null, sdkSecret: null });
    expect(() => parseZoomCredentialSnapshot(JSON.stringify(rest), true)).toThrow("zoom_credentials_refused");
  });
  it.each([null, undefined, 4, "null", "[]", "{}", "broken", "x".repeat(16_385)])("refuses invalid or oversized secret %j", (value) => {
    expect(() => parseZoomCredentialSnapshot(value, true)).toThrow("zoom_credentials_refused");
  });
  it.each([
    { accountId: null }, { clientId: {} }, { clientSecret: ["secret"] }, { clientSecret: "x".repeat(501) },
    { userId: "me" }, { userId: "ME" }, { userId: "host\r\n@example.test" }, { sdkKey: " " }, { sdkSecret: "secret\ud800" },
  ])("refuses malformed fields without exposing credentials %j", (override) => {
    expect(() => parseZoomCredentialSnapshot(JSON.stringify({ ...credentials, ...override }), true)).toThrow(/^zoom_credentials_refused$/);
  });
  it.each(["access_token", "token"] as const)("accepts bounded long %s values", (key) => {
    expect(zoomBearerToken({ [key]: "a".repeat(8192) }, key)).toHaveLength(8192);
    expect(zoomBearerToken({ [key]: "eyJhbGciOiJIUzI1NiJ9.payload_-~+/==" }, key)).toContain("payload");
  });
  it.each([null, [], {}, { token: {} }, { token: ["token"] }, { token: "x".repeat(8193) }, { token: "secret\r\nheader" }, { token: "token secret" }, { token: "token=tail" }])("refuses malformed or oversized tokens without echoing them %j", (value) => {
    expect(() => zoomBearerToken(value, "token")).toThrow(/^zoom_credentials_refused$/);
  });
});
