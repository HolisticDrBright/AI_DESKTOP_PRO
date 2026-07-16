import Link from "next/link";
import { CalendarClock, FilePen, FileSignature, FileWarning, Stethoscope } from "lucide-react";
import { encountersLive, type TimelineEvent } from "@/adapters/encounters.live";
import { getRequestSession } from "@/server/session";
import { toAdapterError } from "@/adapters/errors";
import { Card, CardTitle } from "@/components/ui/bits";
import { StartEncounterButton } from "./StartEncounterButton";

/**
 * Longitudinal patient timeline (live, server component). Backed by
 * get_patient_timeline — CLINICAL events only (encounters, notes,
 * signatures, addenda, appointments). Security-audit events live in
 * /audit-log and are never mixed into the chart.
 */

const EVENT_META: Record<string, { label: string; icon: React.ReactNode }> = {
  "encounter.started": { label: "Encounter", icon: <Stethoscope size={12} strokeWidth={2.2} aria-hidden /> },
  "encounter.completed": { label: "Encounter", icon: <Stethoscope size={12} strokeWidth={2.2} aria-hidden /> },
  "note.draft_created": { label: "Note", icon: <FilePen size={12} strokeWidth={2.2} aria-hidden /> },
  "note.signed": { label: "Note", icon: <FileSignature size={12} strokeWidth={2.2} aria-hidden /> },
  "note.addendum": { label: "Note", icon: <FileSignature size={12} strokeWidth={2.2} aria-hidden /> },
  "note.entered_in_error": { label: "Note", icon: <FileWarning size={12} strokeWidth={2.2} aria-hidden /> },
  appointment: { label: "Appointment", icon: <CalendarClock size={12} strokeWidth={2.2} aria-hidden /> },
};

export async function PatientTimeline({ patientId }: { patientId: string }) {
  const session = await getRequestSession();
  let events: TimelineEvent[] = [];
  let errorMessage: string | null = null;
  let encounterByEvent = new Map<string, string>();

  try {
    const [timeline, encounters] = await Promise.all([
      encountersLive.timeline(patientId, session.token),
      encountersLive.forPatient(patientId, session.token),
    ]);
    events = timeline;
    // Encounter events link straight into the workspace.
    encounterByEvent = new Map(encounters.map((e) => [e.encounterId, e.encounterId]));
  } catch (e) {
    errorMessage = toAdapterError(e).message;
  }

  return (
    <Card className="px-4 py-[14px]">
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="mb-0">
          <Stethoscope size={13} strokeWidth={2.2} className="text-brand" aria-hidden />
          Clinical timeline
        </CardTitle>
        <StartEncounterButton patientId={patientId} compact />
      </div>
      <p className="m-0 mt-1 text-[11px] leading-[1.5] text-faint">
        Clinical events only — encounters, notes, signatures, addenda, appointments. The
        security audit trail lives in the <Link href="/audit-log" className="font-semibold text-action hover:underline">audit log</Link>.
      </p>

      {errorMessage ? (
        <p role="alert" className="m-0 mt-3 rounded-lg bg-critical-tint px-3 py-[8px] text-[12.5px] font-medium text-critical">
          {errorMessage}
        </p>
      ) : events.length === 0 ? (
        <p className="m-0 mt-3 text-[12.5px] text-subtle">
          Nothing recorded yet. Start an encounter to begin this patient&apos;s chart.
        </p>
      ) : (
        <ul className="m-0 mt-3 flex list-none flex-col gap-[6px] p-0" data-testid="timeline-list">
          {events.map((ev, i) => {
            const meta = EVENT_META[ev.eventType] ?? { label: ev.refType, icon: null };
            const encounterLink =
              ev.refType === "encounter" && encounterByEvent.has(ev.refId)
                ? `/patients/${patientId}/encounter/${ev.refId}`
                : null;
            return (
              <li
                key={`${ev.eventType}-${ev.refId}-${i}`}
                className="flex items-baseline gap-2 border-b border-hairline pb-[6px] last:border-b-0 last:pb-0"
              >
                <span className="w-[118px] shrink-0 text-[11px] text-faint tabular-nums">
                  {new Date(ev.eventAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-bold tracking-[0.03em] text-subtle uppercase">
                  {meta.icon}
                  {meta.label}
                </span>
                <span className="min-w-0 text-[12.5px] text-body">
                  {encounterLink ? (
                    <Link href={encounterLink} className="font-semibold text-action hover:underline">
                      {ev.title}
                    </Link>
                  ) : (
                    ev.title
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
