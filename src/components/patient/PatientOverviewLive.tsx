"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ClipboardList,
  FileText,
  FlaskConical,
  Pill as PillIcon,
  ShieldAlert,
  Stethoscope,
  Users,
} from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type {
  LiveChangeBriefItem,
  LivePatientOverview,
  OverviewSourceLink,
} from "@/adapters/live-types";
import { ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";
import { PatientProgramsLive } from "@/components/programs/PatientProgramsLive";
import { PatientAppIntakeCard } from "@/components/patient/PatientAppIntakeCard";
import { PatientRelationshipsCard } from "@/components/patient/PatientRelationshipsCard";
import { Card, CardTitle } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";
import { patientPath } from "@/lib/routes";

/**
 * Patient overview — CLINICAL, real data only.
 *
 * Every panel renders VERIFIED rows from the bounded `get_patient_overview`
 * aggregate (practitioner JWT, RLS, org membership, patient access — enforced
 * in the database, not here). Where a metric has no governed source — health
 * score, wearables, active protocol — the panel says "Not enough verified
 * data". Nothing on this screen is synthesized, extrapolated, or scored.
 *
 * "What changed since the last visit" is computed server-side from the record,
 * anchored to the previous signed encounter; every item links to its source
 * record with its date.
 */

const NOT_ENOUGH = "Not enough verified data";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Where a change-brief/source link navigates: always a real surface. */
function sourceHref(patientId: string, src: OverviewSourceLink): string {
  switch (src.kind) {
    case "lab_observation":
    case "lab_document":
      return patientPath(patientId, "labs");
    case "encounter":
      return `/patients/${patientId}/encounter/${src.id}`;
    case "note":
      return patientPath(patientId, "chart");
    case "appointment":
      return "/calendar";
    case "queue_item":
      return "/tasks";
    default:
      return patientPath(patientId, "chart");
  }
}

function SectionEmpty({ label }: { label: string }) {
  return <p className="m-0 px-1 py-2 text-[12px] text-faint">{label}</p>;
}

function NotEnough({ what }: { what: string }) {
  return (
    <div className="flex items-start gap-2 rounded-[10px] border border-hairline-2 bg-sunken px-3 py-[10px]">
      <AlertTriangle size={13} strokeWidth={2} className="mt-[1px] shrink-0 text-slate-badge" aria-hidden />
      <div className="text-[12px] leading-[1.5] text-subtle">
        <span className="font-semibold text-body">{NOT_ENOUGH}</span> — {what}
      </div>
    </div>
  );
}

export function PatientOverviewLive({ patientId }: { patientId: string }) {
  const [data, setData] = useState<LivePatientOverview | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.patients
      .overview(patientId)
      .then((o) => {
        if (alive) setData(o);
      })
      .catch((e) => {
        if (alive)
          setError(
            isAdapterError(e)
              ? { message: e.safeMessage, code: e.code }
              : { message: "Unable to load the patient overview." },
          );
      });
    return () => {
      alive = false;
    };
  }, [patientId, reloadKey]);

  if (error) {
    return (
      <div className="pt-4">
        <ClinicalError message={error.message} onRetry={() => setReloadKey((k) => k + 1)} />
      </div>
    );
  }
  if (!data) return <ClinicalLoading label="Loading verified record…" />;

  const d = data.demographics;

  return (
    <section data-screen-label="Patient overview (live)" className="grid gap-3 pt-3 pb-8 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-3">
        {/* What changed since the last visit */}
        <Card className="px-4 py-[13px]">
          <CardTitle className="mb-1">
            <Activity size={13} strokeWidth={2} className="text-brand" aria-hidden />
            What changed since the last visit
          </CardTitle>
          <p className="m-0 mb-2 text-[11px] text-faint">
            {data.changesSinceLastVisit.anchorEncounterAt
              ? `Since the last signed encounter (${fmtDate(data.changesSinceLastVisit.anchorEncounterAt)}). Every item links to its source.`
              : "No prior signed encounter — showing recent verified activity. Every item links to its source."}
          </p>
          {data.changesSinceLastVisit.items.length === 0 ? (
            <SectionEmpty label="No verified changes on the record." />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
              {data.changesSinceLastVisit.items.map((item: LiveChangeBriefItem, i) => (
                <li key={`${item.source.kind}-${item.source.id}-${i}`}>
                  <Link
                    href={sourceHref(patientId, item.source)}
                    className="flex items-baseline justify-between gap-3 rounded-lg border border-hairline-2 bg-card px-3 py-[7px] hover:border-action focus-visible:outline-2 focus-visible:outline-action"
                  >
                    <span className="min-w-0 truncate text-[12px] font-medium text-body">{item.label}</span>
                    <span className="shrink-0 text-[10.5px] text-faint">{fmtDateTime(item.source.at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Clinical lists: conditions / medications / allergies */}
        <div className="grid gap-3 md:grid-cols-3">
          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-1">
              <Stethoscope size={13} strokeWidth={2} className="text-brand" aria-hidden />
              Problem list
            </CardTitle>
            {data.conditions.length === 0 ? (
              <SectionEmpty label="No conditions recorded." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                {data.conditions.map((c) => (
                  <li key={c.id} className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="min-w-0 truncate font-medium text-body">
                      {c.name}
                      {c.icd10 && <span className="ml-1 text-[10px] text-faint">{c.icd10}</span>}
                    </span>
                    <Pill tone={c.status === "active" ? "warning" : "slate"}>{c.status}</Pill>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-1">
              <PillIcon size={13} strokeWidth={2} className="text-brand" aria-hidden />
              Medications
            </CardTitle>
            {data.medications.length === 0 ? (
              <SectionEmpty label="No medications recorded." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                {data.medications.map((m) => (
                  <li key={m.id} className="text-[12px]">
                    <span className="font-medium text-body">{m.name}</span>
                    <span className="text-subtle">
                      {m.dose ? ` · ${m.dose}` : ""}
                      {m.frequency ? ` · ${m.frequency}` : ""}
                    </span>
                    {m.status !== "active" && (
                      <span className="ml-1 text-[10.5px] text-faint">({m.status})</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-1">
              <ShieldAlert size={13} strokeWidth={2} className="text-critical" aria-hidden />
              Allergies
            </CardTitle>
            {data.allergies.length === 0 ? (
              <SectionEmpty label="No allergies recorded." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                {data.allergies.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="min-w-0 truncate font-medium text-body">
                      {a.allergen}
                      {a.reaction && <span className="text-subtle"> — {a.reaction}</span>}
                    </span>
                    {a.severity && (
                      <Pill tone={a.severity === "severe" || a.severity === "life_threatening" ? "critical" : "warning"}>
                        {a.severity.replace("_", " ")}
                      </Pill>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Labs + encounters */}
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-1">
              <FlaskConical size={13} strokeWidth={2} className="text-brand" aria-hidden />
              Latest labs
            </CardTitle>
            {data.labs.markerCount === 0 ? (
              <SectionEmpty label="No lab results on file." />
            ) : (
              <>
                <p className="m-0 mb-2 text-[11px] text-subtle">
                  {data.labs.markerCount} observations · {data.labs.awaitingReview} awaiting review ·{" "}
                  {data.labs.abnormal} flagged abnormal · latest {fmtDate(data.labs.latestCollectedAt)}
                </p>
                <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                  {data.labs.recent.map((r) => (
                    <li key={r.id} className="flex items-baseline justify-between gap-2 text-[12px]">
                      <span className="min-w-0 truncate font-medium text-body">{r.markerName}</span>
                      <span className="flex shrink-0 items-baseline gap-2">
                        <span className="text-subtle">{r.valueDisplay}</span>
                        <Pill
                          tone={
                            r.status.startsWith("critical")
                              ? "critical"
                              : r.status === "high" || r.status === "low"
                                ? "warning"
                                : "slate"
                          }
                        >
                          {r.status}
                        </Pill>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="m-0 mt-2 text-[11.5px]">
                  <Link href={patientPath(patientId, "labs")} className="font-semibold text-action hover:underline">
                    Open labs &amp; reasoning →
                  </Link>
                </p>
              </>
            )}
          </Card>

          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-1">
              <FileText size={13} strokeWidth={2} className="text-brand" aria-hidden />
              Recent encounters
            </CardTitle>
            {data.recentEncounters.length === 0 ? (
              <SectionEmpty label="No encounters recorded." />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                {data.recentEncounters.map((e) => (
                  <li key={e.id}>
                    <Link
                      href={`/patients/${patientId}/encounter/${e.id}`}
                      className="flex items-baseline justify-between gap-2 rounded px-1 py-[2px] text-[12px] hover:bg-sunken"
                    >
                      <span className="min-w-0 truncate font-medium text-body">
                        {e.encounterType} · {fmtDate(e.occurredAt)}
                      </span>
                      <Pill tone={e.noteStatus === "signed" ? "positive" : e.noteStatus === "none" ? "slate" : "warning"}>
                        {e.noteStatus === "none" ? "no note" : `note ${e.noteStatus}`}
                      </Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Consent-scoped patient-reported V2 profile and intake */}
        <PatientAppIntakeCard patientId={patientId} />

        {/* Programs: real enrollments pinned to published versions */}
        <PatientProgramsLive patientId={patientId} />

        {/* Ungoverned metrics: explicit honesty, never a number */}
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-2">Health score</CardTitle>
            <NotEnough what="a health score requires a governed algorithm (inputs, version, and review status). None is defined, so no score is calculated." />
          </Card>
          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-2">Wearables &amp; recovery</CardTitle>
            {data.wearableSources.length === 0 ? (
              <NotEnough what="no wearable source is connected for this patient." />
            ) : (
              <SectionEmpty label={data.wearableSources.join(", ")} />
            )}
          </Card>
        </div>
      </div>

      {/* Rail: demographics, care team, appointments, tasks, gaps */}
      <div className="flex min-w-0 flex-col gap-3">
        <Card className="px-4 py-[13px]">
          <CardTitle className="mb-1">
            <Users size={13} strokeWidth={2} className="text-brand" aria-hidden />
            Patient
          </CardTitle>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-faint">Name</dt>
            <dd className="m-0 font-medium text-body">{d.fullName}</dd>
            <dt className="text-faint">DOB</dt>
            <dd className="m-0 text-body">{d.dateOfBirth ? fmtDate(d.dateOfBirth) : "Not recorded"}</dd>
            <dt className="text-faint">Sex</dt>
            <dd className="m-0 text-body">{d.sex ?? "Not recorded"}</dd>
            <dt className="text-faint">Contact</dt>
            <dd className="m-0 text-body">
              {d.hasEmail || d.hasPhone
                ? [d.hasEmail && "email", d.hasPhone && "phone"].filter(Boolean).join(" · ") + " on file"
                : "None on file"}
            </dd>
          </dl>
        </Card>

        <PatientRelationshipsCard patientId={patientId} />

        <Card className="px-4 py-[13px]">
          <CardTitle className="mb-1">Care team</CardTitle>
          {data.careTeam.length === 0 ? (
            <SectionEmpty label="No practitioner assignment recorded." />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
              {data.careTeam.map((m) => (
                <li key={m.userId} className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="min-w-0 truncate font-medium text-body">
                    {m.displayName}
                    {m.isCaller && <span className="ml-1 text-[10.5px] text-faint">(you)</span>}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-subtle">{m.relationship}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="px-4 py-[13px]">
          <CardTitle className="mb-1">
            <CalendarDays size={13} strokeWidth={2} className="text-brand" aria-hidden />
            Appointments
          </CardTitle>
          {data.recentAppointments.length === 0 ? (
            <SectionEmpty label="No appointments on the record." />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
              {data.recentAppointments.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="min-w-0 truncate text-body">
                    {a.appointmentType} · {fmtDateTime(a.startsAt)}
                  </span>
                  <Pill tone={a.status === "completed" ? "slate" : a.status === "cancelled" || a.status === "no_show" ? "critical" : "action"}>
                    {a.status}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="px-4 py-[13px]">
          <CardTitle className="mb-1">
            <ClipboardList size={13} strokeWidth={2} className="text-brand" aria-hidden />
            Open review tasks
          </CardTitle>
          {data.openTasks.length === 0 ? (
            <SectionEmpty label="Nothing open for this patient." />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
              {data.openTasks.map((t) => (
                <li key={t.id}>
                  <Link
                    href="/tasks"
                    className="flex items-baseline justify-between gap-2 rounded px-1 py-[2px] text-[12px] hover:bg-sunken"
                  >
                    <span className="min-w-0 truncate font-medium text-body">{t.title}</span>
                    <Pill tone={t.priority === "high" ? "critical" : t.priority === "medium" ? "warning" : "slate"}>
                      {t.priority}
                    </Pill>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {data.missingInformation.length > 0 && (
          <Card className="px-4 py-[13px]">
            <CardTitle className="mb-1">
              <AlertTriangle size={13} strokeWidth={2} className="text-warning-deep" aria-hidden />
              Missing information
            </CardTitle>
            <ul className="m-0 flex list-none flex-col gap-[4px] p-0">
              {data.missingInformation.map((gap) => (
                <li key={gap} className="text-[12px] text-warning-deep">
                  {gap}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <p className="m-0 px-1 text-[10.5px] leading-[1.5] text-faint">
          Verified record only, generated {fmtDateTime(data.generatedAt)}. Panels without a governed
          data source say “{NOT_ENOUGH}” — nothing on this screen is synthesized.
        </p>
      </div>
    </section>
  );
}
