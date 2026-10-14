import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveClient } from "./live-client";

describe("telehealth read cancellation", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ data: { appointmentId: "fixture" } }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("passes the caller's signal to the visit projection read", async () => {
    const controller = new AbortController();
    await liveClient.telehealthVisit("fixture", "2026-10-13", "UTC", controller.signal);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/live/telehealth/visit?");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("passes the same signal to the retained-note read", async () => {
    const controller = new AbortController();
    await liveClient.telehealthNote("fixture", controller.signal);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/live/telehealth/note?");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
