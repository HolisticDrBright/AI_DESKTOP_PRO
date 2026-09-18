import { AwsRecordingTransport, type CaptureTransportSnapshot } from './aws-recording-transport';
import { createCaptureAudioBridge, type CaptureAudioBridge } from './capture-audio-bridge';
import { prepareCapture } from './capture-start';
import type { requestRecordingCapture } from './recording-capture-client';
import type { recordingContentTypeSchema } from '@/contracts/encounterRecordingCapture';
import type { z } from 'zod';

type ContentType = z.infer<typeof recordingContentTypeSchema>;
type Options = {
  encounterId: string; changed: (snapshot: CaptureTransportSnapshot) => void;
  request?: typeof requestRecordingCapture;
  microphone?: () => Promise<MediaStream>;
  bridge?: (lost: () => void) => CaptureAudioBridge;
  recorder?: (stream: MediaStream, mimeType: string) => MediaRecorder;
  supported?: (mimeType: string) => boolean;
  visibility?: Document; events?: Window;
};
/** One recorder/container per AWS session. Never automatically reacquire a
 * microphone or concatenate a newly initialized recorder after page reload.
 * UI must disclose memory-only buffering until durable recovery is qualified.
 */
export function createAwsBrowserRecording(options: Options) {
  const life = new AbortController();
  let action: AbortController | null = null, bridge: CaptureAudioBridge | null = null;
  let recorder: MediaRecorder | null = null, contentType: ContentType | null = null;
  let dropping = false, stopping = false;
  const microphone = options.microphone ?? (() => navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
  const supported = options.supported ?? (type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
  function halt() {
    try {
      if (recorder?.state === 'recording' && !stopping) {
        try { recorder.requestData(); } finally { recorder.pause(); }
      }
    } catch { /* Microphone release below must not depend on recorder state. */ }
    finally { bridge?.releaseMicrophone(); }
  }
  const transport = new AwsRecordingTransport({ encounterId: options.encounterId, changed: options.changed, request: options.request, halt });
  async function perform<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (life.signal.aborted) throw new Error('recording_disposed');
    if (action) throw new Error('recording_busy');
    const current = new AbortController(); action = current;
    try { return await work(AbortSignal.any([life.signal, current.signal])); }
    finally { if (action === current) action = null; }
  }
  function interrupted() {
    action?.abort(); transport.interrupt(); halt();
  }
  const visibility = options.visibility ?? (typeof document !== 'undefined' ? document : undefined);
  const events = options.events ?? (typeof window !== 'undefined' ? window : undefined);
  const hidden = () => { if (visibility?.visibilityState !== 'visible') interrupted(); };
  visibility?.addEventListener('visibilitychange', hidden);
  events?.addEventListener('pagehide', interrupted);
  events?.addEventListener('offline', interrupted);
  const data = (event: BlobEvent) => { if (!dropping && !life.signal.aborted && event.data.size) transport.enqueue(event.data); };
  const error = () => { transport.failCapture(); halt(); };
  async function stopped(signal: AbortSignal) {
    halt(); if (!recorder || recorder.state === 'inactive') return;
    stopping = true;
    const current = recorder;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (failure?: Error) => {
          clearTimeout(timer); current.removeEventListener('stop', success);
          signal.removeEventListener('abort', abort);
          if (failure) reject(failure); else resolve();
        };
        const success = () => finish(), abort = () => finish(new Error('recording_cancelled'));
        const timer = setTimeout(() => finish(new Error('recorder_stop_unconfirmed')), 5000);
        current.addEventListener('stop', success, { once: true });
        signal.addEventListener('abort', abort, { once: true });
        try { if (signal.aborted) abort(); else current.stop(); } catch { finish(new Error('recorder_stop_unconfirmed')); }
      });
    } catch (e) { transport.failCapture(); throw e; }
    finally { stopping = false; bridge?.close(); }
  }
  return {
    snapshot: () => transport.snapshot(),
    check: () => perform(async () => {
      const ready = await transport.check();
      contentType = ready.contentTypes.find(supported) ?? null;
      if (!contentType) throw new Error('recording_encoding_unavailable');
      return ready;
    }),
    start: () => perform(async signal => {
      if (!contentType || recorder) throw new Error('recording_not_ready');
      if (visibility && visibility.visibilityState !== 'visible') throw new Error('recording_page_not_visible');
      const prepared = await prepareCapture({ signal, microphone, authorize: async requestSignal => {
        await transport.start(contentType!, requestSignal);
      } });
      try {
        if (signal.aborted) throw new Error('recording_cancelled');
        bridge = (options.bridge ?? createCaptureAudioBridge)(interrupted);
        bridge.replaceMicrophone(prepared.stream);
        await bridge.activate(signal);
        recorder = (options.recorder ?? ((stream, mimeType) => new MediaRecorder(stream, { mimeType })))(bridge.stream, contentType);
        if (recorder.mimeType.split(';')[0].trim().toLowerCase() !== contentType) throw new Error('recording_encoding_mismatch');
        recorder.addEventListener('dataavailable', data); recorder.addEventListener('error', error);
        if (signal.aborted || transport.snapshot().phase !== 'recording') throw new Error('recording_authorization_expired');
        recorder.start(1500);
      } catch (e) {
        prepared.stream.getTracks().forEach(track => track.stop());
        bridge?.close(); transport.failCapture(); throw e;
      }
    }),
    pause: () => { interrupted(); return perform(async () => transport.pause()); },
    resume: () => perform(async signal => {
      if (!recorder || recorder.state !== 'paused' || !bridge) throw new Error('recording_original_container_required');
      if (visibility && visibility.visibilityState !== 'visible') throw new Error('recording_page_not_visible');
      const prepared = await prepareCapture({ signal, microphone, authorize: async requestSignal => transport.resume(requestSignal) });
      try {
        if (signal.aborted) throw new Error('recording_cancelled');
        bridge.replaceMicrophone(prepared.stream); await bridge.activate(signal);
        if (signal.aborted || transport.snapshot().phase !== 'recording') throw new Error('recording_authorization_expired');
        recorder.resume();
      } catch (e) { prepared.stream.getTracks().forEach(track => track.stop()); interrupted(); throw e; }
    }),
    retry: () => perform(async () => transport.retry()),
    finish: () => perform(async signal => {
      // Authorize flushing already captured bytes without starting a microphone.
      if (transport.snapshot().phase === 'paused') await transport.resume();
      await stopped(signal);
      await transport.finish();
    }),
    discard: () => perform(async signal => {
      dropping = true;
      await stopped(signal);
      await transport.discard();
    }),
    interrupt: interrupted,
    dispose() {
      if (life.signal.aborted) return;
      dropping = true; life.abort(); action?.abort();
      visibility?.removeEventListener('visibilitychange', hidden);
      events?.removeEventListener('pagehide', interrupted);
      events?.removeEventListener('offline', interrupted);
      try { transport.dispose(); } finally {
        if (recorder) {
          recorder.removeEventListener('dataavailable', data); recorder.removeEventListener('error', error);
          try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Already stopped. */ }
        }
        bridge?.close(); bridge = null; recorder = null;
      }
    },
  };
}
export type AwsBrowserRecording = ReturnType<typeof createAwsBrowserRecording>;
