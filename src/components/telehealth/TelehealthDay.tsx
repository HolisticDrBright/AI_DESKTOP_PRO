"use client";

/**
 * Telehealth day view — the entry point for virtual visits.
 *
 * Every row is a real `telehealth` appointment from the Desktop-owned
 * calendar RPC or a scheduled patient-app request from the AWS telehealth
 * boundary. The stat tiles are counts of those rows and nothing else. When
 * the visit boundary is unreachable the rows still render and the screen
 * says consent/meeting state is unknown — it never shows "not signed" for a
 * consent it could not read.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Video } from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import { telehealthAccessLost } from "@/lib/telehealth-access-loss";
import type { TelehealthDay, TelehealthDayVisit, TelehealthVisit } from "@/adapters/telehealth.types";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { Card } from "@/components/ui/bits";
import { ClinicalEmpty, ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { Metric } from "@/components/ui/Metric";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/Pill";
import { patientPath } from "@/lib/routes";
import {
  APPOINTMENT_STATUS_LABEL,
  ConsentDialog,
  PhaseChip,
  fmtTime,
  noteHref,
  patientLabel,
  viewerTimeZone,
  visitHref,
  visitPhase,
} from "./parts";

type LoadState = "loading" | "ready" | "error";

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dayLine(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(
    new Date(y, m - 1, d),
  );
}

export function TelehealthDayView({ initialDate }: { initialDate?: string }) {
  const router = useRouter();
  const [date, setDate] = useState(() => (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : todayLocal()));
  const [state, setState] = useState<LoadState>("loading");
  const [day, setDay] = useState<TelehealthDay | null>(null);
  const [error, setError] = useState<{ message: string; signedOut: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [consentFor, setConsentFor] = useState<TelehealthDayVisit | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api.telehealth
      .day(date, viewerTimeZone())
      .then((result) => {
        if (cancelled) return;
        setDay(result);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (telehealthAccessLost(e)) {
          setDay(null);
          setConsentFor(null);
        }
        setError({
          message: isAdapterError(e) ? e.message : "Telehealth visits could not be loaded.",
          signedOut: isAdapterError(e) && e.code === "unauthenticated",
        });
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [date, reloadKey]);

  const go = (next: string) => {
    setDate(next);
    router.replace(`/telehealth?date=${next}`);
  };

  const serviceAvailable = day?.visitService.available ?? false;
  const stats = useMemo(() => {
    const rows = day?.visits ?? [];
    const phases = rows.map((row) => visitPhase(row, serviceAvailable));
    return {
      total: rows.length,
      consentMissing: phases.filter((p) => p === "consent_missing").length,
      inVisit: phases.filter((p) => p === "in_visit").length,
      awaitingSignature: phases.filter((p) => p === "note_ready" || p === "ended" || p === "ending").length,
    };
  }, [day, serviceAvailable]);

  const onConsentRecorded = (visit: TelehealthVisit) => {
    setDay((current) =>
      current
        ? { ...current, visits: current.visits.map((row) => (row.appointmentId === visit.appointmentId ? { ...row, visit } : row)) }
        : current,
    );
  };

  return (
    <section data-screen-label="Telehealth" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Telehealth"
        title="Telehealth"
        sub={dayLine(date)}
        actions={
          <div className="flex items-center gap-1">
            <Btn size="sm" aria-label="Previous day" onClick={() => go(shiftDate(date, -1))}>
              <ChevronLeft size={14} strokeWidth={2} aria-hidden />
            </Btn>
            <Btn size="sm" onClick={() => go(todayLocal())}>
              <CalendarDays size={13} strokeWidth={2} aria-hidden /> Today
            </Btn>
            <Btn size="sm" aria-label="Next day" onClick={() => go(shiftDate(date, 1))}>
              <ChevronRight size={14} strokeWidth={2} aria-hidden />
            </Btn>
          </div>
        }
      />

      <ClinicalNote className="mb-4">
        <strong>Virtual visits run inside Desktop Pro.</strong> Video is Zoom, embedded here; notes come from
        Zoom&apos;s AI Companion and become chart notes only when you sign them. A visit cannot start without the
        patient&apos;s combined telehealth and recording consent — the server checks the record, not this screen.
      </ClinicalNote>

      {state === "loading" && <ClinicalLoading label="Loading today's telehealth visits…" />}

      {state === "error" && error && (
        <ClinicalError
          message={error.message}
          onRetry={reload}
          actionHref={error.signedOut ? "/login" : undefined}
          actionLabel={error.signedOut ? "Sign in" : undefined}
        />
      )}

      {state === "ready" && day && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Virtual visits" value={stats.total} sub="Telehealth appointments this day" />
            <Metric
              label="Consent missing"
              value={serviceAvailable ? stats.consentMissing : "Unknown"}
              sub={serviceAvailable ? "Cannot start until recorded" : "Visit service unavailable"}
              subTone={serviceAvailable && stats.consentMissing > 0 ? "warning" : undefined}
            />
            <Metric label="In visit" value={serviceAvailable ? stats.inVisit : "Unknown"} sub="Meeting in progress" />
            <Metric
              label="Notes to sign"
              value={serviceAvailable ? stats.awaitingSignature : "Unknown"}
              sub="Ended visits without a signed note"
              subTone={serviceAvailable && stats.awaitingSignature > 0 ? "warning" : undefined}
            />
          </div>

          {!day.visitService.available && (
            <div
              role="status"
              data-testid="telehealth-service-unavailable"
              className="mb-4 rounded-[10px] border border-[rgba(199,126,20,0.35)] bg-warning-tint px-[13px] py-[10px] text-[12px] leading-[1.55] text-warning-deep"
            >
              <strong>Visit service unavailable.</strong> {day.visitService.message} The appointments below come
              from the clinical calendar; consent and meeting state cannot be shown, and visits cannot be started
              from here until the service answers.
            </div>
          )}

          {day.visitService.available && !day.visitService.complete && (
            <div
              role="status"
              data-testid="telehealth-service-partial"
              className="mb-4 rounded-[10px] border border-[rgba(199,126,20,0.35)] bg-warning-tint px-[13px] py-[10px] text-[12px] leading-[1.55] text-warning-deep"
            >
              <strong>Visit list incomplete.</strong> The visit service returned more records than one read can
              carry, so some consent and meeting states below may show as unknown. Open a visit to read its record
              directly.
            </div>
          )}

          {day.visits.length === 0 ? (
            <ClinicalEmpty
              title="No telehealth visits on this day"
              message="Appointments of type Telehealth booked on the calendar, and scheduled patient-app requests, appear here. The calendar answered; there is nothing virtual on this day."
              icon={<Video size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
            />
          ) : (
            <Card>
              <ul className="m-0 list-none divide-y divide-hairline p-0">
                {day.visits.map((row) => {
                  const phase = visitPhase(row, serviceAvailable);
                  const statusLabel = APPOINTMENT_STATUS_LABEL[row.appointmentStatus] ?? row.appointmentStatus;
                  return (
                    <li key={row.appointmentId} data-testid="telehealth-row" className="flex items-center gap-4 px-4 py-3">
                      <div className="w-[76px] shrink-0 text-[12.5px] font-semibold text-ink">
                        {fmtTime(row.startsAt)}
                        <div className="text-[11px] font-medium text-subtle">to {fmtTime(row.endsAt)}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {row.patientId ? (
                            <Link
                              href={patientPath(row.patientId)}
                              className="text-[13px] font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action"
                            >
                              {patientLabel(row)}
                            </Link>
                          ) : (
                            <span className="text-[13px] font-semibold text-ink">{patientLabel(row)}</span>
                          )}
                          <Pill tone="navy">
                            <Video size={10} strokeWidth={2} aria-hidden /> Telehealth
                          </Pill>
                          <Pill tone="slate">{statusLabel}</Pill>
                          <PhaseChip phase={phase} />
                        </div>
                        <div className="mt-[3px] text-[11.5px] text-subtle">
                          {row.practitionerName ?? "Practitioner not recorded"}
                          {row.source === "patient_app" ? " · requested in the patient app" : " · booked on the calendar"}
                          {row.visit?.consents.length
                            ? ` · consent ${row.visit.consents[0].method === "patient_app" ? "signed in the patient app" : "recorded by staff"}`
                            : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {phase === "consent_missing" && (
                          <Btn size="sm" onClick={() => setConsentFor(row)}>
                            Record consent
                          </Btn>
                        )}
                        {(phase === "ready" || phase === "in_visit") && (
                          <BtnLink size="sm" variant="primary" href={visitHref(row)}>
                            {phase === "in_visit" ? "Rejoin visit" : "Start visit"}
                          </BtnLink>
                        )}
                        {phase === "ending" && (
                          <BtnLink size="sm" variant="danger" href={visitHref(row)}>
                            Finish shutdown
                          </BtnLink>
                        )}
                        {(phase === "ended" || phase === "note_ready" || phase === "signed") && (
                          <BtnLink size="sm" variant={phase === "signed" ? "outline" : "primary"} href={noteHref(row)}>
                            {phase === "signed" ? "View note" : "Open note"}
                          </BtnLink>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}

      {consentFor && (
        <ConsentDialog row={consentFor} date={date} open onClose={() => setConsentFor(null)} onRecorded={onConsentRecorded} />
      )}
    </section>
  );
}
