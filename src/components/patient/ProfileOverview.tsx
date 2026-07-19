"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  FileText,
  MessageCircle,
  Phone,
  User,
} from "lucide-react";
import type { PatientDirectoryEntry } from "@/adapters/types";
import { getPatientSummary } from "@/adapters/patients.mock";
import { getProfileExtras } from "@/adapters/patient-profile.mock";
import { patientLedger, useSessionInvoices } from "@/adapters/billing.mock";
import { getCarePlan } from "@/adapters/careplan.mock";
import { formatMinor } from "@/lib/money";
import { patientPath } from "@/lib/routes";
import { Card, CardTitle } from "@/components/ui/bits";
import { Metric } from "@/components/ui/Metric";
import { Pill, Tag } from "@/components/ui/Pill";
import { BtnLink } from "@/components/ui/Btn";

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-[3px]">
      <span className="w-[108px] shrink-0 text-[11.5px] font-semibold text-subtle">{label}</span>
      <span className="min-w-0 flex-1 text-[12.5px] text-body">{value}</span>
    </div>
  );
}

function SectionCard({
  icon,
  title,
  children,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card className="px-4 py-[14px]">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <CardTitle className="flex-1">{title}</CardTitle>
        {action}
      </div>
      {children}
    </Card>
  );
}

/**
 * Patient Overview — the practice-facing profile. Booking history, balance,
 * demographics, contacts, alerts, forms, communications, plus a CONCISE
 * clinical strip (the deep clinical surfaces live in Labs & Reasoning,
 * Care Plan, and Tracking).
 */
export function ProfileOverview({ patient }: { patient: PatientDirectoryEntry }) {
  useSessionInvoices(); // subscribe: checkout updates the balance tile live
  const extras = getProfileExtras(patient.id);
  const ledger = patientLedger(patient.id);
  const summary = getPatientSummary(patient.id);
  const plans = getCarePlan(patient.id);
  const p = (tab: Parameters<typeof patientPath>[1]) => patientPath(patient.id, tab);

  return (
    <div data-screen-label="Patient Overview" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Total bookings" value={extras.booking.total} sub={`Member since ${extras.booking.memberSinceLabel}`} href={p("appointments")} />
        <Metric label="Upcoming" value={extras.booking.upcoming} sub={extras.booking.nextAppointmentLabel.split(" · ")[0] ?? "—"} href={p("appointments")} />
        <Metric label="No-shows" value={extras.booking.noShows} sub={`${extras.booking.cancellations} cancellation${extras.booking.cancellations === 1 ? "" : "s"}`} subTone={extras.booking.noShows > 0 ? "warning" : undefined} href={p("appointments")} />
        <Metric label="Last visit" value={extras.booking.lastVisitLabel} sub={`${extras.booking.sinceLastVisit} ago`} href={p("chart")} />
        <Metric label="Balance" value={formatMinor(ledger.balanceMinor)} sub={ledger.card.status === "missing" ? "No card on file" : `${ledger.card.brand} ····${ledger.card.last4}`} subTone={ledger.balanceMinor > 0 ? "warning" : undefined} href={p("billing")} />
      </div>

      {extras.medicalAlerts.length > 0 && (
        <Card className="border-[rgba(214,84,74,0.35)] bg-[rgba(251,237,236,0.5)] px-4 py-[10px]">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle size={14} strokeWidth={2} className="shrink-0 text-critical" aria-hidden />
            <span className="text-[12px] font-bold text-critical">Medical alerts</span>
            {extras.medicalAlerts.map((a) => (
              <Pill key={a.label} tone={a.tone}>{a.label}</Pill>
            ))}
            <Link href={p("labs") + "?view=reasoning"} className="ml-auto text-[11.5px] font-semibold text-action hover:text-action-deep">
              Open reasoning →
            </Link>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard icon={<User size={14} strokeWidth={1.75} className="text-action" aria-hidden />} title="Demographics & contact">
            <KV label="Patient" value={`${patient.name}${extras.pronouns ? ` (${extras.pronouns})` : ""} · ${patient.age == null ? "age not recorded" : `${patient.age} y/o`} · ${patient.sex}`} />
            <KV label="DOB / MRN" value={`${patient.dob} · ${patient.mrn}`} />
            <KV label="Phone" value={<a className="text-action hover:underline" href={`tel:${extras.contact.phone}`}>{extras.contact.phone}</a>} />
            <KV label="Email" value={extras.contact.email} />
            <KV label="Address" value={extras.contact.address} />
            <KV label="Preferred" value={`${extras.contact.preferred} messages`} />
            <KV label="Emergency" value={`${extras.emergency.name} (${extras.emergency.relation}) · ${extras.emergency.phone}`} />
            <KV label="Insurance" value={extras.insurance ? `${extras.insurance.carrier} · ${extras.insurance.plan} · ${extras.insurance.memberId}` : "Self-pay"} />
            <KV label="Referral" value={extras.referralSource} />
            {extras.tags.length > 0 && (
              <KV label="Tags" value={<span className="flex flex-wrap gap-1">{extras.tags.map((t) => <Tag key={t}>{t}</Tag>)}</span>} />
            )}
          </SectionCard>

          <SectionCard
            icon={<FileText size={14} strokeWidth={1.75} className="text-teal" aria-hidden />}
            title="Forms & assessments"
            action={<BtnLink size="sm" href={p("tracking") + "?view=assessments"}>All assessments</BtnLink>}
          >
            {extras.forms.length === 0 ? (
              <p className="m-0 text-[12px] text-faint">No forms on file.</p>
            ) : (
              <div className="flex flex-col">
                {extras.forms.map((f) => (
                  <div key={f.name} className="flex items-center gap-2 border-b border-hairline py-[7px] last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">{f.name}</span>
                    <span className="text-[11.5px] text-subtle">{f.atLabel}</span>
                    <Pill tone={f.status === "complete" ? "positive" : f.status === "overdue" ? "critical" : "slate"}>
                      {f.status === "complete" ? "Complete" : f.status === "overdue" ? "Overdue" : "Assigned"}
                    </Pill>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            icon={<MessageCircle size={14} strokeWidth={1.75} className="text-teal" aria-hidden />}
            title="Communications"
            action={<BtnLink size="sm" href={p("messages")}>Messages</BtnLink>}
          >
            <div className="flex flex-col">
              {extras.comms.map((c) => (
                <Link
                  key={`${c.atLabel}-${c.summary}`}
                  href={c.threadId ? `/inbox?thread=${c.threadId}` : p("messages")}
                  className="flex items-center gap-2 border-b border-hairline py-[7px] last:border-b-0 hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">{c.summary}</span>
                  <span className="shrink-0 text-[11.5px] text-subtle">{c.atLabel}</span>
                </Link>
              ))}
            </div>
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <SectionCard
            icon={<CalendarClock size={14} strokeWidth={1.75} className="text-action" aria-hidden />}
            title="Next appointment"
            action={<BtnLink size="sm" href="/calendar">Calendar</BtnLink>}
          >
            <p className="m-0 text-[13px] font-semibold text-ink">{extras.booking.nextAppointmentLabel}</p>
            <p className="mt-1 mb-0 text-[11.5px] text-subtle">
              Phone: <Phone size={11} className="inline text-faint" aria-hidden /> {extras.contact.phone} · prefers {extras.contact.preferred.toLowerCase()}
            </p>
          </SectionCard>

          {summary && (
            <SectionCard
              icon={<ClipboardList size={14} strokeWidth={1.75} className="text-ai-deep" aria-hidden />}
              title="Clinical summary (concise)"
              action={<BtnLink size="sm" href={p("labs") + "?view=reasoning"}>Full reasoning</BtnLink>}
            >
              <div className="mb-2 flex items-center gap-3">
                <span className="text-[24px] leading-none font-bold tracking-[-0.01em]">{summary.healthScore.value}</span>
                <Pill tone={summary.healthScore.tone}>{summary.healthScore.band}</Pill>
                <span className="text-[11.5px] text-subtle">{summary.healthScore.delta.text}</span>
              </div>
              <div className="mb-2 flex flex-wrap gap-1">
                {summary.riskFlags.map((r) => (
                  <Pill key={r.label} tone={r.tone}>{r.label} · {r.action}</Pill>
                ))}
              </div>
              <ul className="m-0 list-none p-0">
                {summary.priorities.slice(0, 3).map((pr) => (
                  <li key={pr} className="border-b border-hairline py-[6px] text-[12.5px] text-body last:border-b-0">
                    {pr}
                  </li>
                ))}
              </ul>
              <p className="mt-2 mb-0 text-[11px] text-faint">
                Deep dives: <Link className="font-semibold text-action" href={p("labs")}>Labs</Link> ·{" "}
                <Link className="font-semibold text-action" href={p("care-plan")}>Care Plan</Link> ·{" "}
                <Link className="font-semibold text-action" href={p("tracking")}>Tracking</Link>
              </p>
            </SectionCard>
          )}

          <SectionCard
            icon={<ClipboardList size={14} strokeWidth={1.75} className="text-positive" aria-hidden />}
            title="Active care plan"
            action={<BtnLink size="sm" href={p("care-plan")}>Care Plan</BtnLink>}
          >
            {plans.length === 0 ? (
              <p className="m-0 text-[12px] text-faint">No active protocols.</p>
            ) : (
              <div className="flex flex-col">
                {plans.map((pl) => (
                  <Link key={pl.id} href={p("care-plan")} className="flex items-center gap-2 border-b border-hairline py-[7px] last:border-b-0 hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{pl.name}</span>
                      <span className="block text-[11.5px] text-subtle">{pl.phase} · review {pl.nextReviewLabel}</span>
                    </span>
                    <Pill tone={pl.status === "active" ? "positive" : pl.status === "pending-approval" ? "warning" : "slate"}>
                      {pl.status === "pending-approval" ? "Pending approval" : pl.status === "active" ? `${pl.adherencePct}% adherence` : "Completed"}
                    </Pill>
                  </Link>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
