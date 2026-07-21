"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Sparkles, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";

/* ---- minimal Web Speech typings (browser-native, no dependency) -------- */

interface SRAlternative {
  transcript: string;
}
interface SRResult {
  readonly length: number;
  0: SRAlternative;
  isFinal: boolean;
}
interface SRResultList {
  readonly length: number;
  [index: number]: SRResult;
}
interface SREvent {
  resultIndex: number;
  results: SRResultList;
}
interface SRInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
}
type SRConstructor = new () => SRInstance;

function getSR(): SRConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRConstructor;
    webkitSpeechRecognition?: SRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ---- simulated transcript (fallback when the browser has no STT) -------- */

const DEMO_LINES = [
  "Patient reports the neck tension is noticeably improved since the last visit, maybe sixty percent better.",
  "Still getting occasional tension headaches in the afternoon, especially on stressful workdays.",
  "Sleep has been lighter this week, waking around three a.m. a couple of times.",
  "Energy is decent in the mornings but dips hard after lunch.",
  "On exam, the upper trapezius is still tender to palpation bilaterally, right worse than left.",
  "Cervical range of motion is improved, rotation is close to full now.",
  "Pulse is wiry on the left, and the tongue shows a slightly dusky body with a thin white coat.",
  "This looks consistent with liver qi stagnation affecting the neck and shoulders, with some underlying blood deficiency.",
  "Plan is to treat the usual neck and shoulder points, add LI4 and LV3 to move qi, and cup the upper back.",
  "Recommend continuing the magnesium in the evening and a follow-up in one week.",
];

export interface StructuredNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

/** Naive keyword bucketing. Explicitly a draft for the practitioner to edit —
 * never a clinical conclusion on its own. */
export function structureTranscript(text: string): StructuredNote {
  const out: StructuredNote = { subjective: "", objective: "", assessment: "", plan: "" };
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const has = (s: string, words: string[]) => words.some((w) => s.toLowerCase().includes(w));
  for (const s of sentences) {
    if (has(s, ["plan", "recommend", "follow-up", "follow up", "treat", "needle", "point", "cup", "moxa", "prescrib", "home care", "continue", "return in", "in one week", "frequenc"])) {
      out.plan += (out.plan ? " " : "") + s;
    } else if (has(s, ["consistent with", "diagnos", "pattern", "impression", "stagnation", "deficiency", "qi", "damp", "heat", "yin", "yang"])) {
      out.assessment += (out.assessment ? " " : "") + s;
    } else if (has(s, ["on exam", "exam", "palpat", "range of motion", "tender", "pulse", "tongue", "observed", "blood pressure", "temperature", "swelling", "rotation"])) {
      out.objective += (out.objective ? " " : "") + s;
    } else {
      out.subjective += (out.subjective ? " " : "") + s;
    }
  }
  return out;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Status = "idle" | "recording" | "paused" | "done";

export function AiScribePanel({
  open,
  onClose,
  onAppendToSubjective,
  onApplyStructured,
  onSaveTranscript,
  canStructure,
}: {
  open: boolean;
  onClose: () => void;
  onAppendToSubjective: (text: string) => void;
  onApplyStructured: (note: StructuredNote) => void;
  onSaveTranscript: (text: string) => void;
  canStructure: boolean;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [applied, setApplied] = useState<string | null>(null);

  const srSupported = useRef<boolean>(false);
  const activeRef = useRef(false);
  const recRef = useRef<SRInstance | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoIdx = useRef(0);

  useEffect(() => {
    srSupported.current = getSR() !== null;
  }, []);

  const stopTimers = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (demoRef.current) clearInterval(demoRef.current);
    timerRef.current = null;
    demoRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    stopTimers();
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    recRef.current = null;
  }, [stopTimers]);

  useEffect(() => teardown, [teardown]);

  // Reset when the panel is closed.
  useEffect(() => {
    if (!open) {
      teardown();
      setStatus("idle");
      setFinalText("");
      setInterim("");
      setElapsed(0);
      setApplied(null);
      demoIdx.current = 0;
    }
  }, [open, teardown]);

  const startTimer = () => {
    stopTimers();
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  };

  const startReal = () => {
    const SR = getSR()!;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e: SREvent) => {
      let interimText = "";
      let finalChunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalChunk += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (finalChunk) setFinalText((t) => (t ? `${t} ${finalChunk.trim()}` : finalChunk.trim()));
      setInterim(interimText);
    };
    rec.onerror = () => {
      // Permission denied or no speech — fall back to the demo stream.
      recRef.current = null;
      startDemo();
    };
    rec.onend = () => {
      // Chrome ends the session periodically; restart while still active.
      if (activeRef.current) {
        try {
          rec.start();
        } catch {
          /* already stopped */
        }
      }
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      startDemo();
    }
  };

  const startDemo = () => {
    demoRef.current = setInterval(() => {
      const line = DEMO_LINES[demoIdx.current];
      if (!line) {
        if (demoRef.current) clearInterval(demoRef.current);
        demoRef.current = null;
        return;
      }
      setFinalText((t) => (t ? `${t} ${line}` : line));
      demoIdx.current += 1;
    }, 1600);
  };

  const begin = () => {
    activeRef.current = true;
    setStatus("recording");
    setApplied(null);
    startTimer();
    if (srSupported.current) startReal();
    else startDemo();
  };

  const pause = () => {
    activeRef.current = false;
    setStatus("paused");
    stopTimers();
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
  };

  const resume = () => {
    activeRef.current = true;
    setStatus("recording");
    startTimer();
    if (srSupported.current && !recRef.current) startReal();
    else if (!srSupported.current) startDemo();
  };

  const stop = () => {
    activeRef.current = false;
    setStatus("done");
    setInterim("");
    stopTimers();
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    recRef.current = null;
  };

  const transcript = (finalText + (interim ? ` ${interim}` : "")).trim();
  const recording = status === "recording";

  const applyAppend = () => {
    if (!finalText.trim()) return;
    onAppendToSubjective(finalText.trim());
    onSaveTranscript(finalText.trim());
    setApplied("Transcript added to Subjective.");
  };
  const applyStructured = () => {
    if (!finalText.trim()) return;
    onApplyStructured(structureTranscript(finalText.trim()));
    onSaveTranscript(finalText.trim());
    setApplied("Draft structured into SOAP fields — review before signing.");
  };

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-ink/20"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="AI Scribe"
        className="fixed top-0 right-0 z-50 flex h-full w-full max-w-[420px] flex-col border-l border-line bg-card shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-ai-tint">
              <Sparkles size={16} className="text-ai" aria-hidden />
            </span>
            <div>
              <h2 className="text-[14px] font-bold text-ink">AI Scribe</h2>
              <p className="text-[11px] text-subtle">Ambient note capture</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI Scribe"
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted hover:bg-sunken hover:text-ink"
          >
            <X size={17} aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* status row */}
          <div className="mb-3 flex items-center justify-between rounded-[10px] border border-line bg-sunken px-3 py-[10px]">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-2.5 w-2.5 rounded-full",
                  recording ? "animate-pulse bg-critical" : status === "done" ? "bg-positive" : "bg-ghost",
                )}
                aria-hidden
              />
              <span className="text-[12.5px] font-semibold text-ink">
                {status === "idle" && "Ready"}
                {status === "recording" && "Listening…"}
                {status === "paused" && "Paused"}
                {status === "done" && "Captured"}
              </span>
            </div>
            <span className="text-[13px] font-bold tabular-nums text-muted">{fmt(elapsed)}</span>
          </div>

          {!srSupported.current && (
            <p className="mb-3 rounded-[8px] bg-warning-tint px-3 py-2 text-[11.5px] leading-snug text-warning-deep">
              This browser has no speech recognition, so a <b>simulated</b> transcript
              is streamed for demonstration. In Chrome, live microphone transcription is used.
            </p>
          )}

          {/* transcript */}
          <div className="mb-3 min-h-[160px] rounded-[10px] border border-line bg-card px-3 py-[10px] text-[13px] leading-relaxed text-body">
            {transcript ? (
              <p className="m-0">
                {finalText}
                {interim && <span className="text-faint"> {interim}</span>}
              </p>
            ) : (
              <p className="m-0 text-ghost">
                Press <b>Start</b> and talk with your patient. The conversation is
                transcribed here in real time.
              </p>
            )}
          </div>

          <p className="mb-3 text-[11px] leading-snug text-faint">
            AI scribe drafts from audio and can be wrong. Nothing here enters the record
            until you review it and sign the note. Audio is not stored.
          </p>

          {applied && (
            <p className="mb-3 rounded-[8px] bg-positive-tint px-3 py-2 text-[12px] font-semibold text-positive">
              {applied}
            </p>
          )}

          {status === "done" && finalText.trim() && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={applyStructured}
                disabled={!canStructure}
                className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-ai text-[13px] font-semibold text-white hover:bg-ai-deep disabled:opacity-40"
              >
                <Sparkles size={15} aria-hidden />
                Auto-structure into SOAP
              </button>
              <button
                type="button"
                onClick={applyAppend}
                className="flex h-10 items-center justify-center gap-2 rounded-[10px] border border-line-btn bg-card text-[13px] font-semibold text-action hover:bg-sunken"
              >
                Append to Subjective
              </button>
            </div>
          )}
        </div>

        {/* controls */}
        <footer className="border-t border-line px-4 py-3">
          {status === "idle" && (
            <button
              type="button"
              onClick={begin}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-[11px] bg-ai text-[14px] font-semibold text-white hover:bg-ai-deep"
            >
              <Mic size={17} aria-hidden />
              Start scribing
            </button>
          )}
          {(status === "recording" || status === "paused") && (
            <div className="flex gap-2">
              {recording ? (
                <button
                  type="button"
                  onClick={pause}
                  className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[11px] border border-line-btn bg-card text-[13px] font-semibold text-ink hover:bg-sunken"
                >
                  <Pause size={16} aria-hidden />
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={resume}
                  className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[11px] border border-line-btn bg-card text-[13px] font-semibold text-ink hover:bg-sunken"
                >
                  <Play size={16} aria-hidden />
                  Resume
                </button>
              )}
              <button
                type="button"
                onClick={stop}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[11px] bg-critical text-[13px] font-semibold text-white hover:brightness-95"
              >
                <Square size={15} aria-hidden />
                Stop
              </button>
            </div>
          )}
          {status === "done" && (
            <button
              type="button"
              onClick={begin}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-[11px] border border-line-btn bg-card text-[13px] font-semibold text-action hover:bg-sunken"
            >
              <Mic size={16} aria-hidden />
              Record again
            </button>
          )}
        </footer>
      </aside>
    </>
  );
}
