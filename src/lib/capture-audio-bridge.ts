/** One stable recorder stream across microphone changes. No speaker connection
 * and no concatenation of separately initialized media containers. */
export function createCaptureAudioBridge(onLost: () => void, context = new AudioContext()) {
  let destination: MediaStreamAudioDestinationNode;
  try { destination = context.createMediaStreamDestination(); }
  catch { void context.close().catch(() => {}); throw new Error("audio_context_unavailable"); }
  let microphone: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let disposed = false;
  let detachListeners = () => {};
  const releaseMicrophone = () => {
    detachListeners();
    detachListeners = () => {};
    try { source?.disconnect(); } catch { /* An ended source may already be detached. */ }
    source = null;
    microphone?.getTracks().forEach(track => track.stop()); microphone = null;
  };
  const close = () => {
    if (disposed) return;
    disposed = true;
    releaseMicrophone();
    destination.stream.getTracks().forEach(track => track.stop());
    void context.close().catch(() => {});
  };
  return {
    stream: destination.stream,
    hasMicrophone: () => !disposed && Boolean(microphone?.getAudioTracks().some(track => track.readyState === "live")),
    replaceMicrophone(next: MediaStream) {
      if (disposed || !next.getAudioTracks().some(track => track.readyState === "live")) {
        next.getTracks().forEach(track => track.stop());
        throw new Error("microphone_unavailable");
      }
      let replacement: MediaStreamAudioSourceNode;
      try { replacement = context.createMediaStreamSource(next); replacement.connect(destination); }
      catch { next.getTracks().forEach(track => track.stop()); throw new Error("microphone_unavailable"); }
      releaseMicrophone();
      microphone = next; source = replacement;
      const lost = () => {
        if (disposed || microphone !== next) return;
        releaseMicrophone();
        onLost();
      };
      next.getAudioTracks().forEach(track => track.addEventListener("ended", lost));
      detachListeners = () => next.getAudioTracks().forEach(track => track.removeEventListener("ended", lost));
    },
    async activate(signal: AbortSignal) {
      if (disposed || signal.aborted) throw new Error("capture_cancelled");
      let cancel = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("audio_context_unavailable"));
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(cancel, 4000);
      });
      try {
        await Promise.race([context.resume(), interrupted]);
        if (disposed || signal.aborted || context.state !== "running") throw new Error("audio_context_unavailable");
      } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
    },
    close,
  };
}
export type CaptureAudioBridge = ReturnType<typeof createCaptureAudioBridge>;
