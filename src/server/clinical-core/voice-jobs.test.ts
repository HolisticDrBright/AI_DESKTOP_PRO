import { beforeEach, describe, expect, test, vi } from "vitest";
import { VoiceJobs, type VoiceJob, type VoiceProvider, type VoiceRepository } from "./voice-jobs";

const owner = "synthetic-owner-a";
const input = { requestId: "11111111-1111-4111-8111-111111111111", consentVersion: "patient-chat-consent/1", purpose: "patient_chat_voice_input", mimeType: "audio/wav", audioBase64: Buffer.alloc(64, 1).toString("base64") };
let now: number, rows: Map<string, VoiceJob>, provider: VoiceProvider, repo: VoiceRepository, service: VoiceJobs;
beforeEach(() => {
  now = 1000; rows = new Map();
  provider = { upload: vi.fn().mockResolvedValue(undefined), start: vi.fn().mockResolvedValue(undefined), status: vi.fn().mockResolvedValue("missing"), transcript: vi.fn().mockResolvedValue("Fictional test message."), remove: vi.fn().mockResolvedValue(undefined) };
  repo = {
    get: async id => rows.has(id) ? { ...rows.get(id)! } : undefined,
    insert: async job => { if (rows.has(job.id)) return false; rows.set(job.id, { ...job }); return true; },
    acquire: async (id, token, at) => { const row = rows.get(id); if (!row || row.state === "cleaned" || (row.leaseUntil ?? 0) >= at) return undefined; Object.assign(row, { leaseToken: token, leaseUntil: at + 90 }); return { ...row }; },
    release: async (id, token, changes) => { const row = rows.get(id)!; if (row.leaseToken !== token) throw new Error("lease_lost"); Object.assign(row, changes); delete row.leaseToken; delete row.leaseUntil; if (row.state === "cleaned") delete row.pending; },
    cancel: async id => { const row = rows.get(id)!; row.cancelled = true; row.nextWork = now; },
    due: async at => [...rows.values()].filter(row => row.pending && row.nextWork <= at).map(row => row.id),
  };
  service = new VoiceJobs(repo, provider, () => now);
});
describe("durable voice lifecycle", () => {
  test("same recording retry retains one job and consent; changed payload is refused", async () => {
    const first = await service.start(owner, input);
    expect(await service.start(owner, input)).toEqual(first);
    expect(rows.size).toBe(1); expect(provider.upload).toHaveBeenCalledOnce();
    expect(rows.get(first.jobId)).toMatchObject({ consentVersion: input.consentVersion, consentAcceptedAt: 1000 });
    await expect(service.start(owner, { ...input, audioBase64: Buffer.alloc(64, 2).toString("base64") })).rejects.toThrow("voice_request_refused");
  });
  test("cross-user status and cancellation do not touch the provider", async () => {
    const job = await service.start(owner, input);
    await expect(service.status("another-owner", job.jobId)).rejects.toThrow("voice_job_not_found");
    await expect(service.cancel("another-owner", job.jobId)).rejects.toThrow("voice_job_not_found");
    expect(provider.status).not.toHaveBeenCalled(); expect(provider.remove).not.toHaveBeenCalled();
    const other = await service.start("another-owner", input);
    expect(other.jobId).not.toBe(job.jobId);
  });
  test("cancellation hides data immediately but waits for provider terminal state before cleanup", async () => {
    const job = await service.start(owner, input);
    vi.mocked(provider.status).mockResolvedValue("processing");
    await service.cancel(owner, job.jobId);
    expect((await service.status(owner, job.jobId)).state).toBe("cancelled");
    expect(provider.remove).not.toHaveBeenCalled(); expect(provider.transcript).not.toHaveBeenCalled();
    vi.mocked(provider.status).mockResolvedValue("ready"); now += 60;
    await service.sweep();
    expect(provider.remove).toHaveBeenCalledOnce();
    expect(rows.get(job.jobId)).toMatchObject({ state: "cleaned", cancelled: true });
    expect(rows.get(job.jobId)?.pending).toBeUndefined();
  });
  test("expiry blocks reads before asynchronous TTL removes metadata", async () => {
    const job = await service.start(owner, input); now += 901;
    vi.mocked(provider.status).mockResolvedValue("processing");
    expect((await service.status(owner, job.jobId)).state).toBe("expired");
    expect(rows.get(job.jobId)?.expiresAt).toBeUndefined();
    expect(provider.transcript).not.toHaveBeenCalled();
  });
  test("partial cleanup failure remains scheduled and never claims cleaned", async () => {
    const job = await service.start(owner, input);
    await service.cancel(owner, job.jobId);
    vi.mocked(provider.remove).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(service.advance(job.jobId)).rejects.toThrow();
    expect(rows.get(job.jobId)?.pending).toBe("work");
    expect(rows.get(job.jobId)?.expiresAt).toBeUndefined();
    now += 60; await service.sweep();
    expect(rows.get(job.jobId)?.state).toBe("cleaned");
  });
  test("abandoned upload is tracked and cleaned without a phone", async () => {
    vi.mocked(provider.upload).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(service.start(owner, input)).rejects.toThrow();
    const job = [...rows.values()][0]; expect(job.state).toBe("uploading");
    now += 901; await service.sweep();
    expect(rows.get(job.id)?.state).toBe("cleaned");
    expect(provider.start).not.toHaveBeenCalled();
  });
  test("a lease prevents duplicate concurrent provider starts", async () => {
    const job = await service.start(owner, input);
    await Promise.all([service.advance(job.jobId), service.advance(job.jobId)]);
    expect(provider.start).toHaveBeenCalledOnce();
  });
  test("cancellation during transcript read suppresses the response", async () => {
    const job = await service.start(owner, input);
    vi.mocked(provider.status).mockResolvedValue("ready");
    vi.mocked(provider.transcript).mockImplementation(async () => { await service.cancel(owner, job.jobId); return "Fictional test message."; });
    expect(await service.status(owner, job.jobId)).toEqual({ jobId: job.jobId, state: "cancelled" });
  });
  test("unsigned consent versions and unknown request fields are refused", async () => {
    await expect(service.start(owner, { ...input, consentVersion: "old" })).rejects.toThrow();
    await expect(service.start(owner, { ...input, owner: "another-owner" })).rejects.toThrow();
    expect(rows.size).toBe(0);
  });
});
