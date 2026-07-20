"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckSquare,
  FileWarning,
  FlaskConical,
  Inbox as InboxIcon,
  RefreshCw,
  Video,
} from "lucide-react";
import { APPOINTMENT_TYPE_META, appointmentTitle } from "@/adapters/calendar.mock";
import { setFrontDeskStatus, statusLabel, STATUS_TONE } from "@/adapters/appointments.session";
import { useTodayData, type TodayAppointment } from "@/adapters/today.mock";
import { useFeedback } from "@/lib/feedback";
import { formatMinor } from "@/lib/money";
import { patientPath } from "@/lib/routes";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { Metric } from "@/components/ui/Metric";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/Pill";
import { DemoNote } from "@/components/ui/DemoNote";

const WEEKDAY_LABEL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

function fmtTime(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h = ((h24 + 11) % 12) + 1;
  return `${h}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

function ScheduleRow({ item }: { item: TodayAppointment }) {
  const { announce } = useFeedback();
  const { appt, override, telehealth, balanceMinor, hasAlerts } = item;
  const meta = APPOINTMENT_TYPE_META[appt.type];
  const status = override?.status;
  const done = status === "cancelled" || status === "no-show" || status === "completed" || status === "rescheduled";

  return (
    <div className="flex items-center gap-3 border-b border-hairline px-4 py-[9px] last:border-b-0">
      <div className="w-[70px] shrink-0 text-[12px] font-semibold text-muted tabular-nums">
        {fmtTime(appt.start)}
      </div>
      <span
        aria-hidden
        className="h-[26px] w-[3px] shrink-0 rounded-full"
        style={{ background: `var(--color-${meta.tone === "action" ? "action" : meta.tone})` }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[7px]">
          {appt.patientId ? (
            <Link
              href={patientPath(appt.patientId)}
              className="truncate text-[13px] font-semibold text-ink hover:text-action focus-visible:outline-2 focus-visible:outline-action"
            >
              {appt.patientName}
            </Link>
          ) : (
            <span className="truncate text-[13px] font-semibold text-ink">{appt.patientName}</span>
          )}
          {hasAlerts && (
            <AlertTriangle size={12} strokeWidth={2} className="shrink-0 text-warning" aria-label="Has medical alerts" />
          )}
          {balanceMinor > 0 && (
            <Pill tone="warning" title="Outstanding balance">{formatMinor(balanceMinor)} due</Pill>
          )}
        </div>
        <div className="truncate text-[11.5px] text-subtle">
          {appointmentTitle(appt.type)} · {appt.durationMin} min · {appt.location}
          {appt.type === "telehealth" && !telehealth.ready && (
            <span className="text-warning-deep"> · {telehealth.detail}</span>
          )}
        </div>
      </div>
      {status ? (
        <Pill tone={STATUS_TONE[status]}>
          {statusLabel(status)}
          {override?.rescheduledToLabel ? ` · ${override.rescheduledToLabel}` : ""}
        </Pill>
      ) : (
        <Btn
          size="sm"
          onClick={() => {
            const r = setFrontDeskStatus(appt, "arrived");
            announce(r.message);
          }}
        >
          Arrive
        </Btn>
      )}
      {status === "arrived" && (
        <Btn
          size="sm"
          variant="primary"
          onClick={() => {
            const r = setFrontDeskStatus(appt, "checked-in");
            announce(r.message);
          }}
        >
          Check in
        </Btn>
      )}
      {!done && (
        <BtnLink size="sm" variant="ghost" href={`/calendar?appt=${appt.id}`}>
          Open
        </BtnLink>
      )}
    </div>
  );
}

function BriefSection({
  icon,
  title,
  count,
  href,
  hrefLabel,
  children,
  tone,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  href: string;
  hrefLabel: string;
  children: ReactNode;
  tone?: "critical" | "warning";
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-[10px]">
        <span
          className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px]"
          style={{
            background: tone === "critical" ? "var(--color-critical-tint)" : tone === "warning" ? "var(--color-warning-tint)" : "var(--color-number-tint)",
          }}
        >
          {icon}
        </span>
        <CardTitle className="flex-1">{title}</CardTitle>
        <span className="text-[11.5px] font-semibold text-subtle">{count}</span>
        <Link
          href={href}
          className="text-[11.5px] font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action"
        >
          {hrefLabel}
        </Link>
      </div>
      {count === 0 ? (
        <p className="m-0 px-4 py-3 text-[12px] text-faint">Nothing waiting.</p>
      ) : (
        <div className="flex flex-col">{children}</div>
      )}
    </Card>
  );
}

function BriefRow({ href, title, sub, pill }: { href: string; title: string; sub: string; pill?: ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 border-b border-hairline px-4 py-[8px] last:border-b-0 hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">{title}</span>
        <span className="block truncate text-[11.5px] text-subtle">{sub}</span>
      </span>
      {pill}
    </Link>
  );
}

export function TodayWorkspace({
  dateLine,
  weekday,
  isWeekendFallback,
}: {
  dateLine: string;
  weekday: number;
  isWeekendFallback: boolean;
}) {
  const data = useTodayData(weekday, isWeekendFallback);
  const [nowMin, setNowMin] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNowMin(d.getHours() * 60 + d.getMinutes());
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const markerIndex = useMemo(() => {
    if (nowMin == null) return -1;
    const idx = data.schedule.findIndex((s) => s.appt.start >= nowMin);
    return idx === -1 ? data.schedule.length : idx;
  }, [data.schedule, nowMin]);

  const remaining = data.schedule.filter(
    (s) => !s.override?.status || s.override.status === "arrived" || s.override.status === "checked-in",
  ).length;

  return (
    <section data-screen-label="Today" className="mx-auto max-w-[1560px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Today"
        title="Today"
        sub={
          <>
            {dateLine}
            {data.isWeekendFallback && " · Weekend — showing Monday's schedule template (demo)"}
          </>
        }
        actions={
          <>
            <BtnLink href="/calendar">Open calendar</BtnLink>
            <BtnLink href="/tasks" variant="primary">
              Review queue ({data.openTaskCount})
            </BtnLink>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Appointments today" value={data.schedule.length} sub={`${remaining} remaining · ${data.arrivals.length} arrived`} href="/calendar" />
        <Metric label="Unread messages" value={data.unreadThreads.length} sub={`${data.scheduleRequests.length} schedule request${data.scheduleRequests.length === 1 ? "" : "s"}`} subTone={data.unreadThreads.length ? "teal" : undefined} href="/inbox" />
        <Metric label="Tasks due today" value={data.tasksDue.length} sub={`${data.openTaskCount} open in queue`} subTone={data.tasksDue.length ? "warning" : undefined} href="/tasks" />
        <Metric label="Unsigned notes" value={data.unsignedNotes.length} sub="Sign to lock the record" subTone={data.unsignedNotes.length ? "critical" : undefined} href={patientPath(data.unsignedNotes[0]?.patientId ?? "p-78435", "chart")} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-hairline px-4 py-[10px]">
              <CalendarClock size={15} strokeWidth={1.75} className="text-action" aria-hidden />
              <CardTitle className="flex-1">{WEEKDAY_LABEL[data.weekday]} schedule</CardTitle>
              <span className="text-[11.5px] text-subtle">
                {data.telehealthPending.length > 0 && (
                  <span className="font-semibold text-warning-deep">
                    {data.telehealthPending.length} telehealth link{data.telehealthPending.length === 1 ? "" : "s"} unconfirmed
                  </span>
                )}
              </span>
            </div>
            <div className="flex flex-col">
              {data.schedule.map((item, i) => (
                <div key={item.appt.id}>
                  {i === markerIndex && nowMin != null && (
                    <div className="flex items-center gap-2 px-4 py-[2px]" role="presentation" data-testid="now-marker">
                      <span className="h-[2px] flex-1 rounded bg-critical" />
                      <span className="text-[10.5px] font-bold text-critical">NOW · {fmtTime(nowMin)}</span>
                      <span className="h-[2px] w-6 rounded bg-critical" />
                    </div>
                  )}
                  <ScheduleRow item={item} />
                </div>
              ))}
              {markerIndex === data.schedule.length && nowMin != null && data.schedule.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-[4px]">
                  <span className="h-[2px] flex-1 rounded bg-critical opacity-60" />
                  <span className="text-[10.5px] font-bold text-critical">End of day · {fmtTime(nowMin)}</span>
                </div>
              )}
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BriefSection
              icon={<FlaskConical size={14} strokeWidth={1.75} className="text-action" aria-hidden />}
              title="Lab uploads ready for review"
              count={data.labReviews.length}
              href="/tasks?filter=extraction-review"
              hrefLabel="Open queue"
            >
              {data.labReviews.map((q) => (
                <BriefRow key={q.id} href={patientPath(q.patientId, "labs")} title={q.title} sub={`${q.patientName} · ${q.due}`} pill={<Pill tone={q.priority === "High" ? "critical" : "slate"}>{q.priority}</Pill>} />
              ))}
            </BriefSection>
            <BriefSection
              icon={<CheckSquare size={14} strokeWidth={1.75} className="text-action" aria-hidden />}
              title="Approvals waiting"
              count={data.approvals.length}
              href="/tasks?filter=protocol-approval"
              hrefLabel="Open queue"
            >
              {data.approvals.map((q) => (
                <BriefRow key={q.id} href="/tasks" title={q.title} sub={`${q.patientName} · ${q.due}`} pill={<Pill tone={q.priority === "High" ? "critical" : "slate"}>{q.priority}</Pill>} />
              ))}
            </BriefSection>
            <BriefSection
              icon={<FileWarning size={14} strokeWidth={1.75} className="text-critical" aria-hidden />}
              title="Unsigned notes"
              count={data.unsignedNotes.length}
              href={patientPath(data.unsignedNotes[0]?.patientId ?? "p-78435", "chart")}
              hrefLabel="Open chart"
              tone="critical"
            >
              {data.unsignedNotes.map((n) => (
                <BriefRow key={n.id} href={patientPath(n.patientId, "chart")} title={n.encounterLabel} sub={`${n.patientName} · ${n.ageLabel}`} pill={<Pill tone="critical">Unsigned</Pill>} />
              ))}
            </BriefSection>
            <BriefSection
              icon={<Video size={14} strokeWidth={1.75} className="text-navy" aria-hidden />}
              title="Telehealth readiness"
              count={data.telehealthPending.length}
              href="/calendar"
              hrefLabel="Calendar"
            >
              {data.telehealthPending.map((t) => (
                <BriefRow key={t.appt.id} href={`/calendar?appt=${t.appt.id}`} title={`${fmtTime(t.appt.start)} · ${t.appt.patientName}`} sub={t.telehealth.detail} pill={<Pill tone="warning">Unconfirmed</Pill>} />
              ))}
            </BriefSection>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <BriefSection
            icon={<AlertTriangle size={14} strokeWidth={1.75} className="text-critical" aria-hidden />}
            title="Needs attention today"
            count={data.attention.length}
            href="/tasks"
            hrefLabel="Queue"
            tone="critical"
          >
            {data.attention.map((a) => (
              <BriefRow key={a.id} href={a.href} title={a.title} sub={a.sub} pill={<Pill tone={a.tone}>{a.tone === "critical" ? "Critical" : "Attention"}</Pill>} />
            ))}
          </BriefSection>
          <BriefSection
            icon={<InboxIcon size={14} strokeWidth={1.75} className="text-teal" aria-hidden />}
            title="Unread patient messages"
            count={data.unreadThreads.length}
            href="/inbox"
            hrefLabel="Inbox"
          >
            {data.unreadThreads.map((t) => (
              <BriefRow key={t.id} href={`/inbox?thread=${t.id}`} title={t.subject} sub={`${t.patientName} · ${t.atLabel}`} pill={t.priority ? <Pill tone={t.priority === "High" ? "critical" : "slate"}>{t.priority}</Pill> : undefined} />
            ))}
          </BriefSection>
          <BriefSection
            icon={<CalendarClock size={14} strokeWidth={1.75} className="text-action" aria-hidden />}
            title="Schedule requests"
            count={data.scheduleRequests.length}
            href="/inbox?filter=schedule-request"
            hrefLabel="Inbox"
          >
            {data.scheduleRequests.map((t) => (
              <BriefRow key={t.id} href={`/inbox?thread=${t.id}`} title={t.subject} sub={`${t.patientName} · ${t.atLabel}`} />
            ))}
          </BriefSection>
          <BriefSection
            icon={<RefreshCw size={14} strokeWidth={1.75} className="text-warning-deep" aria-hidden />}
            title="Failed syncs"
            count={data.failedSyncs.length}
            href="/integrations?tab=sync-log"
            hrefLabel="Sync log"
            tone="warning"
          >
            {data.failedSyncs.map((s) => (
              <BriefRow key={s.id} href="/integrations?tab=sync-log" title={s.connector} sub={`${s.summary} · ${s.counts}`} pill={<Pill tone="warning">Failed</Pill>} />
            ))}
          </BriefSection>
          <DemoNote>
            Demo brief — schedule, messages, tasks, and ledgers are synthetic session data. Actions
            update dependent screens for this browser session only.
          </DemoNote>
        </div>
      </div>
    </section>
  );
}
