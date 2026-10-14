import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { visit, note } = vi.hoisted(() => ({ visit: vi.fn(), note: vi.fn() }));
vi.mock("@/adapters", () => ({ api: { telehealth: { visit, note } } }));

import { loadVisitRow } from "./parts";

describe("telehealth visit read deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visit.mockReset();
    note.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("refuses an unanswered visit read instead of loading forever", async () => {
    visit.mockReturnValue(new Promise(() => {}));
    const pending = loadVisitRow("appointment", "2026-10-13");
    const refusal = expect(pending).rejects.toMatchObject({
      code: "unavailable",
      message: "The visit did not load in time. Please try again.",
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await refusal;
    expect(note).not.toHaveBeenCalled();
    expect((visit.mock.calls[0]?.[3] as AbortSignal).aborted).toBe(true);
  });

  it("uses one deadline for the visit and its retained note", async () => {
    visit.mockResolvedValue({ appointmentId: "appointment", visit: { status: "ended" } });
    note.mockReturnValue(new Promise(() => {}));
    const pending = loadVisitRow("appointment", "2026-10-13");
    const refusal = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(20_000);
    await refusal;
    expect(note).toHaveBeenCalledOnce();
    expect((note.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
  });

  it("returns a completed read and clears the deadline", async () => {
    const row = { appointmentId: "appointment", visit: { status: "ended" } };
    const full = { status: "ended", note: { status: "signed" } };
    visit.mockResolvedValue(row);
    note.mockResolvedValue(full);
    await expect(loadVisitRow("appointment", "2026-10-13")).resolves.toEqual({ ...row, visit: full });
    expect(vi.getTimerCount()).toBe(0);
  });
});
