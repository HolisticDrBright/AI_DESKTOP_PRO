import { afterEach, describe, expect, it, vi } from "vitest";
import { requestEncounterStart } from "./encounter-start";

const input = { patientId: "aaaaaaaa-1111-2222-3333-444444444401", visitType: "follow-up" };
const encounterId = "eeeeeeee-2222-3333-4444-444444444401";
afterEach(() => vi.useRealTimers());

describe("encounter creation outcome", () => {
  it("returns a same-patient path for the created encounter with one POST", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { encounterId } }));
    await expect(requestEncounterStart(input, new AbortController().signal, fetcher)).resolves.toEqual({ kind: "ready", href: `/patients/${input.patientId}/encounter/${encounterId}` });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(input) });
  });
  it("bounds even an unresponsive transport without replaying the mutation", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const result = requestEncounterStart(input, new AbortController().signal, fetcher);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(result).resolves.toEqual({ kind: "unconfirmed" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("does not accept a late success after cancellation", async () => {
    let complete!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const controller = new AbortController();
    const result = requestEncounterStart(input, controller.signal, fetcher);
    controller.abort();
    await expect(result).resolves.toEqual({ kind: "unconfirmed" });
    complete(Response.json({ data: { encounterId } }));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not issue an already cancelled or invalid-patient request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(requestEncounterStart(input, AbortSignal.abort(), fetcher)).resolves.toEqual({ kind: "unconfirmed" });
    await expect(requestEncounterStart({ ...input, patientId: "../other" }, new AbortController().signal, fetcher)).resolves.toEqual({ kind: "refused" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([null, "../other", "https://external.example", "", 123])("refuses an unsafe or absent returned identifier: %s", async id => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { encounterId: id } }));
    await expect(requestEncounterStart(input, new AbortController().signal, fetcher)).resolves.toEqual({ kind: "unconfirmed" });
  });
  it("distinguishes an explicit refusal from an uncertain server failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("private details", { status: 403 })).mockResolvedValueOnce(new Response("private details", { status: 500 }));
    await expect(requestEncounterStart(input, new AbortController().signal, fetcher)).resolves.toEqual({ kind: "refused" });
    await expect(requestEncounterStart(input, new AbortController().signal, fetcher)).resolves.toEqual({ kind: "unconfirmed" });
  });
});
