"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type {
  TelehealthConsentArtifact,
  TelehealthDayVisit,
  TelehealthVisit,
  TelehealthVisitNote,
  TelehealthVisitNoteSummary,
} from "@/adapters/telehealth.types";
import { Btn } from "@/components/ui/Btn";
import { Field, TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import type { Tone } from "@/adapters/types";

/** Database status vocabulary → front-desk label. Unknown values pass through. */
export const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  arrived: "Arrived",
  in_encounter: "In room",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/** The viewer's IANA zone: every day and every visit action is resolved in it, never in the server's. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "Time not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Time not recorded";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The viewer-local calendar day an instant falls on. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function visitHref(row: Pick<TelehealthDayVisit, "appointmentId" | "startsAt">): string {
  return `/telehealth/visit/${row.appointmentId}?date=${localDate(row.startsAt)}`;
}

export function noteHref(row: Pick<TelehealthDayVisit, "appointmentId" | "startsAt">): string {
  return `/telehealth/visit/${row.appointmentId}/note?date=${localDate(row.startsAt)}`;
}

/** Patient name as the chart knows it, or an honest placeholder — never a fabricated name. */
export function patientLabel(row: Pick<TelehealthDayVisit, "patientName" | "source">): string {
  if (row.patientName) return row.patientName;
  return row.source === "patient_app" ? "Patient-app booking (no chart link)" : "Unknown";
}

export function isFullNote(note: TelehealthVisitNote | TelehealthVisitNoteSummary | null): note is TelehealthVisitNote {
  return Boolean(note && "aiSections" in note);
}

/**
 * The row from the day list carries a state-only projection of the visit
 * (no flags, quick notes or note bodies). Screens that need the full record
 * read it from the note route, which returns the whole visit.
 */
export async function loadVisitRow(appointmentId: string, date: string): Promise<TelehealthDayVisit> {
  const row = await api.telehealth.visit(appointmentId, date, viewerTimeZone());
  if (!row.visit) return row;
  const full = await api.telehealth.note(appointmentId);
  return { ...row, visit: full };
}

export type VisitPhase =
  | "unknown"
  | "consent_missing"
  | "ready"
  | "in_visit"
  | "ending"
  | "ended"
  | "note_ready"
  | "signed"
  | "cancelled";

/** The one state the day view, the visit screen and the note screen all agree on. */
export function visitPhase(row: TelehealthDayVisit, serviceAvailable: boolean): VisitPhase {
  if (!serviceAvailable) return "unknown";
  const visit = row.visit;
  if (row.appointmentStatus === "cancelled" || row.appointmentStatus === "no_show" || visit?.status === "cancelled") return "cancelled";
  if (!visit || !visit.consentSigned) return "consent_missing";
  if (visit.note?.status === "signed") return "signed";
  if (visit.status === "ending") return "ending";
  if (visit.status === "ended") return visit.note ? "note_ready" : "ended";
  if (visit.status === "in_visit") return "in_visit";
  return "ready";
}

export const PHASE_META: Record<VisitPhase, { label: string; tone: Tone }> = {
  unknown: { label: "Visit state unknown", tone: "slate" },
  consent_missing: { label: "Consent not signed", tone: "warning" },
  ready: { label: "Consent signed", tone: "positive" },
  in_visit: { label: "In visit", tone: "ai" },
  ending: { label: "Meeting shutdown pending", tone: "critical" },
  ended: { label: "Visit ended · note pending", tone: "navy" },
  note_ready: { label: "Note awaiting signature", tone: "warning" },
  signed: { label: "Note signed", tone: "positive" },
  cancelled: { label: "Cancelled", tone: "slate" },
};

export function PhaseChip({ phase }: { phase: VisitPhase }) {
  const meta = PHASE_META[phase];
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Unknown" : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(d);
}

/**
 * Record the combined telehealth + recording/AI-notes consent on the desktop
 * for a visit booked outside the patient app. The dialog first reads the
 * practice's CURRENT approved consent artifact (version, jurisdiction, hash)
 * from the governed consent authority; the staff member attests the patient
 * agreed to that exact version. The server re-validates the artifact and the
 * appointment before anything is written, and re-checks the authority again
 * when the visit starts — this dialog is not the control.
 */
export function ConsentDialog({
  row,
  date,
  open,
  onClose,
  onRecorded,
}: {
  row: TelehealthDayVisit;
  date: string;
  open: boolean;
  onClose: () => void;
  onRecorded: (visit: TelehealthVisit) => void;
}) {
  const [artifact, setArtifact] = useState<TelehealthConsentArtifact | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [location, setLocation] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setArtifact(null);
    setArtifactError(null);
    api.telehealth
      .consentArtifact()
      .then((result) => {
        if (!cancelled) setArtifact(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setArtifactError(isAdapterError(e) ? e.message : "The practice's consent artifact could not be read.");
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (!artifact) return;
    if (!agreed || signerName.trim().length < 2) {
      setError("Type the patient's full name and confirm they agreed to both parts of the consent.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const visit = await api.telehealth.recordConsent({
        appointmentId: row.appointmentId,
        date,
        timeZone: viewerTimeZone(),
        artifactId: artifact.artifactId,
        artifactVersion: artifact.artifactVersion,
        contentSha256: artifact.contentSha256,
        signerName: signerName.trim(),
        patientLocation: location.trim() || null,
        representativeAuthority: "self",
        agreed: true,
      });
      onRecorded(visit);
      onClose();
    } catch (e) {
      setError(isAdapterError(e) ? e.message : "The consent could not be recorded.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(24,42,61,0.32)] px-4 backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        className="animate-fade-up w-[500px] max-w-full overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.97)] shadow-[0_24px_64px_rgba(24,42,61,0.22)]"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-action-tint">
            <ShieldCheck size={17} strokeWidth={2} className="text-action" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="consent-title" className="m-0 text-[15px] font-bold text-ink">Record telehealth consent</h2>
            <p className="mt-1 mb-0 text-[12.5px] leading-normal text-body">
              One combined consent covers the video visit and its recording with AI notes. Both parts are
              required; a visit cannot start without it.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 px-5 pt-4">
          <div data-testid="consent-artifact" className="rounded-lg border border-hairline-2 bg-surface px-3 py-2 text-[12px] leading-[1.5] text-subtle">
            {artifact ? (
              <>
                <strong className="text-body">Current approved consent:</strong> version {artifact.artifactVersion}, jurisdiction{" "}
                {artifact.jurisdiction}, approved {fmtDate(artifact.approvedAt)}. Content hash {artifact.contentSha256.slice(0, 12)}…
              </>
            ) : artifactError ? (
              <span role="alert" className="text-critical">{artifactError}</span>
            ) : (
              "Reading the practice's current approved consent…"
            )}
          </div>
          <Field label="Patient's full name (as they stated it)">
            <TextInput autoFocus value={signerName} onChange={(e) => setSignerName(e.target.value)} placeholder="Full name" />
          </Field>
          <Field label="Where the patient will be during the visit (state, optional)">
            <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. CA" />
          </Field>
          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-[1.45] text-body">
            <input type="checkbox" className="mt-[3px]" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              The patient read, or had read to them, the current approved version of the combined telehealth and
              recording / AI-notes consent shown above and agreed to both parts. I am recording that agreement on
              their behalf.
            </span>
          </label>
          {error && (
            <p role="alert" className="m-0 rounded-lg border border-[rgba(214,84,74,0.3)] bg-critical-tint px-3 py-2 text-[12px] text-critical">
              {error}
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-hairline bg-[rgba(247,250,252,0.6)] px-5 py-3">
          <Btn onClick={onClose} disabled={working}>Cancel</Btn>
          <Btn variant="primary" onClick={() => void submit()} disabled={working || !artifact}>
            {working ? "Recording…" : "Record consent"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
