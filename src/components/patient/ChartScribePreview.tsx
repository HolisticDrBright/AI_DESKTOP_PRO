"use client";

import { useEffect, useRef, useState } from "react";
import { FilePlus2, Mic, Pause, Play, ShieldCheck, Square, WandSparkles } from "lucide-react";
import { Btn } from "@/components/ui/Btn";
import { DemoNote } from "@/components/ui/DemoNote";

type Phase = "ready" | "recording" | "paused" | "review";

function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const PREVIEW_TRANSCRIPT = `Patient reports that morning energy has improved since the last visit, but sleep remains inconsistent with two overnight awakenings most nights. They deny new adverse effects and report following the current nutrition and supplement plan approximately five days per week.

Practitioner reviewed the recent sleep pattern, discussed barriers to a consistent evening routine, and agreed to continue the current phase while tracking sleep timing and afternoon fatigue before the next visit.`;

export function ChartScribePreview({
  patientName,
  onCreateDraft,
}: {
  patientName: string;
  onCreateDraft: (transcript: string) => void;
}) {
  const [consented, setConsented] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const begin = async () => {
    setError(null);
    if (!consented) {
      setError("Confirm recording consent before starting capture.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser does not expose microphone recording.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        chunksRef.current = [];
      };
      recorder.start(1000);
      setSeconds(0);
      setTranscript("");
      setPhase("recording");
    } catch {
      setError("Microphone access was not granted. Check the browser permission and try again.");
    }
  };

  const pauseOrResume = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setPhase("paused");
    } else if (recorder.state === "paused") {
      recorder.resume();
      setPhase("recording");
    }
  };

  const stop = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
    setTranscript(PREVIEW_TRANSCRIPT);
    setPhase("review");
  };

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="rounded-lg border border-line bg-sunken p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-action-tint text-action"><ShieldCheck size={17} aria-hidden /></span>
          <div>
            <p className="m-0 text-[13px] font-bold text-ink">Consent before capture</p>
            <p className="mt-1 mb-0 text-[11.5px] leading-[1.5] text-subtle">Confirm every participant understands the visit will be recorded for transcription and practitioner-reviewed note drafting.</p>
          </div>
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-[12px] font-medium text-body">
          <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} disabled={phase === "recording" || phase === "paused"} className="mt-px accent-action" />
          {patientName} and all people in the room granted recording, transcription, and AI-drafting consent.
        </label>
      </div>

      <div className="rounded-lg border border-line bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-full ${phase === "recording" ? "animate-pulse bg-critical text-white" : "bg-action-tint text-action"}`}><Mic size={18} aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[13px] font-bold text-ink">{phase === "recording" ? "Recording visit" : phase === "paused" ? "Recording paused" : phase === "review" ? "Transcript ready for review" : "In-person AI scribe"}</p>
            <p className="mt-px mb-0 text-[11.5px] text-subtle">{phase === "ready" ? "Audio stays local in this visual preview." : `${clock(seconds)} · ${phase === "review" ? "audio discarded" : "microphone active"}`}</p>
          </div>
          {phase === "ready" && <Btn variant="primary" onClick={() => void begin()} disabled={!consented}><Mic size={13} aria-hidden /> Start recording</Btn>}
          {(phase === "recording" || phase === "paused") && (
            <>
              <Btn onClick={pauseOrResume}>{phase === "paused" ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}{phase === "paused" ? "Resume" : "Pause"}</Btn>
              <Btn variant="primary" onClick={stop}><Square size={12} aria-hidden /> Stop &amp; transcribe</Btn>
            </>
          )}
        </div>
        {error && <p role="alert" className="mt-3 mb-0 rounded-lg bg-critical-tint px-3 py-2 text-[11.5px] font-semibold text-critical">{error}</p>}
      </div>

      {phase === "review" && (
        <div className="rounded-lg border border-line bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <WandSparkles size={14} className="text-ai" aria-hidden />
            <p className="m-0 text-[13px] font-bold text-ink">Transcript and draft source</p>
            <span className="ml-auto rounded-full bg-ai-tint px-2 py-px text-[10px] font-bold text-ai">Demo fixture</span>
          </div>
          <textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} rows={9} aria-label="Scribe transcript" className="w-full resize-y rounded-lg border border-line bg-sunken px-3 py-2 text-[12px] leading-[1.55] text-body outline-none focus-visible:outline-2 focus-visible:outline-action" />
          <div className="mt-3 flex justify-end">
            <Btn variant="primary" disabled={!transcript.trim()} onClick={() => onCreateDraft(transcript)}><FilePlus2 size={13} aria-hidden /> Create practitioner-review draft</Btn>
          </div>
        </div>
      )}

      <DemoNote>
        Visual prototype: microphone capture is local and discarded; the displayed transcript is synthetic. In live mode, the existing server-issued capture authorization, participant consent scopes, immutable transcript, provider gate, retention, deletion, and practitioner-signature safeguards remain required.
      </DemoNote>
    </div>
  );
}
