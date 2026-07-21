"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typings for the Web Speech API (not in the default DOM lib).
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  0: SpeechRecognitionAlternative;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface ScribeState {
  supported: boolean;
  recording: boolean;
  /** Text confirmed since the current session started. */
  finalTranscript: string;
  /** In-flight words not yet finalised. */
  interim: string;
  error: string | null;
  elapsedMs: number;
}

/**
 * AI Scribe backed by the browser's on-device speech recognition.
 *
 * `onFinalChunk` fires with each finalised phrase so the caller can append it
 * to the targeted note section live. No audio leaves the browser; swapping in a
 * server transcription service later only changes this hook, not its consumers.
 */
export function useScribe(onFinalChunk: (text: string) => void) {
  const ctorRef = useRef<SpeechRecognitionCtor | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const chunkRef = useRef(onFinalChunk);
  const startedAt = useRef<number>(0);
  const keepAlive = useRef(false);
  const [state, setState] = useState<ScribeState>({
    supported: false,
    recording: false,
    finalTranscript: "",
    interim: "",
    error: null,
    elapsedMs: 0,
  });

  chunkRef.current = onFinalChunk;

  useEffect(() => {
    ctorRef.current = getRecognitionCtor();
    setState((s) => ({ ...s, supported: ctorRef.current !== null }));
  }, []);

  // Tick the elapsed timer while recording.
  useEffect(() => {
    if (!state.recording) return;
    const id = window.setInterval(() => {
      setState((s) => ({ ...s, elapsedMs: Date.now() - startedAt.current }));
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.recording]);

  const stop = useCallback(() => {
    keepAlive.current = false;
    recRef.current?.stop();
    setState((s) => ({ ...s, recording: false, interim: "" }));
  }, []);

  const start = useCallback(() => {
    const Ctor = ctorRef.current;
    if (!Ctor) {
      setState((s) => ({ ...s, error: "Speech recognition isn't available in this browser." }));
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      let interim = "";
      let finalChunk = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const result = e.results[i];
        const text = result[0].transcript;
        if (result.isFinal) finalChunk += text;
        else interim += text;
      }
      if (finalChunk) {
        const cleaned = finalChunk.trim();
        chunkRef.current(cleaned);
        setState((s) => ({
          ...s,
          finalTranscript: (s.finalTranscript ? `${s.finalTranscript} ` : "") + cleaned,
          interim: "",
        }));
      } else {
        setState((s) => ({ ...s, interim }));
      }
    };

    rec.onerror = (e) => {
      // "no-speech" / "aborted" are transient; surface the rest.
      if (e.error === "no-speech" || e.error === "aborted") return;
      const msg =
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access was blocked. Enable it to use the scribe."
          : `Scribe error: ${e.error}`;
      keepAlive.current = false;
      setState((s) => ({ ...s, error: msg, recording: false, interim: "" }));
    };

    rec.onend = () => {
      // The engine auto-stops on silence; restart while the user wants to record.
      if (keepAlive.current) {
        try {
          rec.start();
        } catch {
          /* already starting */
        }
      }
    };

    recRef.current = rec;
    keepAlive.current = true;
    startedAt.current = Date.now();
    setState((s) => ({ ...s, recording: true, error: null, finalTranscript: "", interim: "", elapsedMs: 0 }));
    try {
      rec.start();
    } catch {
      /* start() throws if called twice; ignore */
    }
  }, []);

  const toggle = useCallback(() => {
    if (state.recording) stop();
    else start();
  }, [state.recording, start, stop]);

  useEffect(() => () => {
    keepAlive.current = false;
    recRef.current?.abort();
  }, []);

  return { ...state, start, stop, toggle };
}
