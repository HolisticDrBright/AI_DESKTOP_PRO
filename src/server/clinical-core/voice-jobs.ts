import { createHash, randomUUID } from "node:crypto";

export const VOICE_CONSENT = "patient-chat-consent/1";
export type VoiceJob = {
  id: string; owner: string; inputHash: string; format: "mp4" | "wav";
  state: "uploading" | "queued" | "running" | "ready" | "failed" | "cleaned";
  consentVersion: string; consentAcceptedAt: number; createdAt: number; readableUntil: number;
  cancelled: boolean; nextWork: number; pending?: string; leaseToken?: string; leaseUntil?: number; expiresAt?: number;
};
export type VoiceStatus = { jobId: string; state: "processing" | "ready" | "cancelled" | "expired" | "failed"; transcript?: string };
export interface VoiceRepository {
  get(id: string): Promise<VoiceJob | undefined>;
  insert(job: VoiceJob): Promise<boolean>;
  acquire(id: string, token: string, now: number): Promise<VoiceJob | undefined>;
  release(id: string, token: string, changes: Partial<VoiceJob>): Promise<void>;
  cancel(id: string, owner: string): Promise<void>;
  due(now: number): Promise<string[]>;
}
export interface VoiceProvider {
  upload(job: VoiceJob, bytes: Uint8Array): Promise<void>;
  start(job: VoiceJob): Promise<void>;
  status(job: VoiceJob): Promise<"missing" | "processing" | "ready" | "failed">;
  transcript(job: VoiceJob): Promise<string>;
  remove(job: VoiceJob): Promise<void>;
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const refused = () => Object.assign(new Error("voice_request_refused"), { status: 400 });
const missing = () => Object.assign(new Error("voice_job_not_found"), { status: 404 });
export class VoiceJobs {
  constructor(private repo: VoiceRepository, private provider: VoiceProvider, private now = () => Math.floor(Date.now() / 1000)) {}

  async start(owner: string, input: Record<string, unknown>): Promise<VoiceStatus> {
    if (Object.keys(input).some(key => !["requestId", "audioBase64", "mimeType", "consentVersion", "purpose"].includes(key))
      || typeof input.requestId !== "string" || !idPattern.test(input.requestId)
      || input.consentVersion !== VOICE_CONSENT || input.purpose !== "patient_chat_voice_input"
      || !["audio/m4a", "audio/mp4", "audio/wav"].includes(String(input.mimeType))
      || typeof input.audioBase64 !== "string" || input.audioBase64.length > 5_500_000
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audioBase64)) throw refused();
    const bytes = Buffer.from(input.audioBase64, "base64");
    const format = input.mimeType === "audio/wav" ? "wav" : "mp4";
    if (bytes.length < 32 || bytes.length > 4_125_000) throw refused();
    const hash = createHash("sha256").update(bytes).update(format).digest("hex");
    const id = createHash("sha256").update(`${owner}:${input.requestId}`).digest("hex");
    const now = this.now();
    await this.repo.insert({ id, owner, inputHash: hash, format, state: "uploading", cancelled: false,
      consentVersion: VOICE_CONSENT, consentAcceptedAt: now, createdAt: now, readableUntil: now + 900, nextWork: now + 60, pending: "work" });
    const existing = await this.repo.get(id);
    if (!existing || existing.owner !== owner || existing.inputHash !== hash) throw refused();
    if (existing.cancelled || existing.readableUntil <= now || existing.state === "cleaned") return this.publicStatus(existing);
    const token = randomUUID();
    const job = await this.repo.acquire(id, token, now);
    if (job) {
      let state = job.state;
      try {
        if (state === "uploading" && !job.cancelled && job.readableUntil > this.now()) {
          await this.provider.upload(job, bytes);
          state = "queued";
        }
      } finally { await this.repo.release(id, token, { state, nextWork: this.now() + 1 }); }
    }
    return this.publicStatus((await this.repo.get(id))!);
  }

  private publicStatus(job: VoiceJob): VoiceStatus {
    const state = job.cancelled ? "cancelled" : job.readableUntil <= this.now() ? "expired"
      : job.state === "cleaned" || job.state === "failed" ? "failed" : job.state === "ready" ? "ready" : "processing";
    return { jobId: job.id, state };
  }

  async status(owner: string, id: string): Promise<VoiceStatus> {
    const initial = await this.repo.get(id);
    if (!initial || initial.owner !== owner) throw missing();
    await this.advance(id);
    const job = (await this.repo.get(id))!;
    const result = this.publicStatus(job);
    if (result.state !== "ready") return result;
    const transcript = await this.provider.transcript(job);
    // Re-check cancellation after the object read, not only before it.
    const latest = this.publicStatus((await this.repo.get(id))!);
    if (latest.state !== "ready") return latest;
    if (!transcript.trim() || transcript.length > 4000) throw new Error("voice_transcription_unavailable");
    return { ...result, transcript };
  }

  async cancel(owner: string, id: string): Promise<VoiceStatus> {
    const job = await this.repo.get(id);
    if (!job || job.owner !== owner) throw missing();
    await this.repo.cancel(id, owner);
    // Logical cancellation is immediate; cleanup is not falsely claimed complete.
    return { jobId: id, state: "cancelled" };
  }

  async advance(id: string): Promise<void> {
    const token = randomUUID();
    const job = await this.repo.acquire(id, token, this.now());
    if (!job) return;
    const changes: Partial<VoiceJob> = { nextWork: this.now() + 30 };
    try {
      if (job.state === "cleaned") return;
      const current = await this.provider.status(job);
      if (job.cancelled || job.readableUntil <= this.now() || job.state === "failed" || current === "failed") {
        if (current === "processing") return; // Transcribe cannot delete nonterminal jobs.
        await this.provider.remove(job);
        changes.state = "cleaned";
        changes.expiresAt = this.now() + 86_400;
      } else if (current === "ready") {
        changes.state = "ready";
        changes.nextWork = job.readableUntil;
      } else if (current === "processing") {
        changes.state = "running";
      } else if (job.state === "queued" || job.state === "running") {
        const latest = await this.repo.get(id);
        if (!latest || latest.cancelled || latest.readableUntil <= this.now()) return;
        await this.provider.start(job); // Deterministic provider job name makes retry safe.
        changes.state = "running";
      }
    } finally { await this.repo.release(id, token, changes); }
  }

  async sweep(): Promise<void> {
    let failures = 0;
    for (const id of await this.repo.due(this.now())) {
      try { await this.advance(id); } catch { failures += 1; console.warn("voice_job_retry_pending"); }
    }
    if (failures) throw new Error("voice_cleanup_retry_required");
  }
}
