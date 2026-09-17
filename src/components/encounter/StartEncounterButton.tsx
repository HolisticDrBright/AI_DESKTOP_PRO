"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Stethoscope } from "lucide-react";
import { requestEncounterStart, type EncounterStartResult } from "@/lib/encounter-start";

/**
 * Starts (or idempotently resumes) an encounter and opens the workspace.
 * With an appointmentId, the server enforces appointment ↔ patient ↔ org
 * agreement and returns the existing in-progress encounter if one exists.
 */
type StartEncounterButtonProps = {
  patientId: string;
  appointmentId?: string;
  visitType?: string;
  label?: string;
  compact?: boolean;
  purpose?: "encounter" | "scribe";
};

export function StartEncounterButton(props: StartEncounterButtonProps) {
  return <EncounterStartAction key={JSON.stringify([props.patientId, props.appointmentId, props.visitType])} {...props} />;
}

function EncounterStartAction({
  patientId,
  appointmentId,
  visitType = "follow-up",
  label = "Start encounter",
  compact = false,
  purpose = "encounter",
}: StartEncounterButtonProps) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EncounterStartResult | null>(null);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => { attempt.current?.abort(); attempt.current = null; }, []);

  const start = async () => {
    if (attempt.current || result?.kind === "ready" || result?.kind === "unconfirmed") return;
    const controller = new AbortController();
    attempt.current = controller;
    setWorking(true);
    setError(null);
    try {
      const outcome = await requestEncounterStart({ patientId, visitType, appointmentId }, controller.signal);
      if (controller.signal.aborted || attempt.current !== controller) return;
      setResult(outcome);
      if (outcome.kind === "ready") {
        // Keep a document-navigation escape hatch if the client router stalls.
        // It opens the returned encounter and never replays the POST.
        try { router.push(outcome.href); } catch { /* The direct link remains usable. */ }
      } else if (outcome.kind === "unconfirmed") {
        setError("We could not confirm whether the encounter was created. Review the chart timeline before starting another.");
      } else {
        setError("The encounter request was refused. Check your practitioner access and try again.");
      }
    } finally {
      if (attempt.current === controller) { attempt.current = null; setWorking(false); }
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      {result?.kind === "ready" ? (
        <span role="status" className="text-[12px] text-subtle">
          Encounter ready. {" "}
          <a href={result.href} className="font-semibold text-action underline" data-testid="open-created-encounter">Open encounter</a>
        </span>
      ) : result?.kind === "unconfirmed" ? (
        <a href={`/patients/${encodeURIComponent(patientId)}/chart`} className="text-[12px] font-semibold text-action underline">Review chart timeline</a>
      ) : <button
        type="button"
        disabled={working}
        onClick={() => void start()}
        className={`flex cursor-pointer items-center gap-[6px] rounded-lg border-none bg-action font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60 ${
          compact ? "h-7 px-2 text-[11.5px]" : "h-9 px-3 text-[12.5px]"
        }`}
      >
        {purpose === "scribe" ? <Mic size={compact ? 11 : 13} strokeWidth={2.2} aria-hidden /> : <Stethoscope size={compact ? 11 : 13} strokeWidth={2.2} aria-hidden />}
        {working ? "Opening…" : label}
      </button>}
      {error && (
        <span role="alert" className="text-[11px] font-medium text-critical">
          {error}
        </span>
      )}
    </span>
  );
}
