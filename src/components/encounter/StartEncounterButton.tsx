"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Stethoscope } from "lucide-react";

/**
 * Starts (or idempotently resumes) an encounter and opens the workspace.
 * With an appointmentId, the server enforces appointment ↔ patient ↔ org
 * agreement and returns the existing in-progress encounter if one exists.
 */
export function StartEncounterButton({
  patientId,
  appointmentId,
  visitType = "follow-up",
  label = "Start encounter",
  compact = false,
}: {
  patientId: string;
  appointmentId?: string;
  visitType?: string;
  label?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/live/emr/encounter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId, visitType, appointmentId }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { encounterId?: string };
        error?: { message?: string };
      };
      if (!res.ok || !json.data?.encounterId) {
        setError(json.error?.message ?? "Could not start the encounter.");
        setWorking(false);
        return;
      }
      router.push(`/patients/${patientId}/encounter/${json.data.encounterId}`);
    } catch {
      setError("The encounter service is unreachable right now.");
      setWorking(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={working}
        onClick={() => void start()}
        className={`flex cursor-pointer items-center gap-[6px] rounded-lg border-none bg-action font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60 ${
          compact ? "h-7 px-2 text-[11.5px]" : "h-9 px-3 text-[12.5px]"
        }`}
      >
        <Stethoscope size={compact ? 11 : 13} strokeWidth={2.2} aria-hidden />
        {working ? "Opening…" : label}
      </button>
      {error && (
        <span role="alert" className="text-[11px] font-medium text-critical">
          {error}
        </span>
      )}
    </span>
  );
}
