export type CaptureReply = { ok: boolean; status: number; data?: { ok?: boolean; status?: string; captureToken?: string | null } };
export type ResumeAuthorization = { kind: "authorized"; token: string } | { kind: "refused" } | { kind: "unconfirmed" };

/** Resume is never inferred from HTTP success alone, or from a prior token. */
export async function authorizeCaptureResume(
  signal: AbortSignal,
  request: (action: "resume" | "heartbeat", signal: AbortSignal) => Promise<CaptureReply>,
): Promise<ResumeAuthorization> {
  if (signal.aborted) return { kind: "unconfirmed" };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 8000);
  let onAbort = () => {};
  const interrupted = new Promise<ResumeAuthorization>(resolve => {
    onAbort = () => resolve({ kind: "unconfirmed" });
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const classifyFailure = (reply: CaptureReply): ResumeAuthorization => ({
    kind: !reply.ok && reply.status >= 400 && reply.status < 500 ? "refused" : "unconfirmed",
  });
  try {
    const work = (async (): Promise<ResumeAuthorization> => {
      const resumed = await request("resume", controller.signal);
      if (controller.signal.aborted) return { kind: "unconfirmed" };
      if (!resumed.ok || resumed.data?.ok !== true) return classifyFailure(resumed);
      const beat = await request("heartbeat", controller.signal);
      if (controller.signal.aborted) return { kind: "unconfirmed" };
      if (!beat.ok || beat.data?.ok !== true || beat.data.status !== "active"
        || typeof beat.data.captureToken !== "string" || !beat.data.captureToken.trim()) return classifyFailure(beat);
      return { kind: "authorized", token: beat.data.captureToken };
    })().catch((): ResumeAuthorization => ({ kind: "unconfirmed" }));
    return await Promise.race([work, interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
