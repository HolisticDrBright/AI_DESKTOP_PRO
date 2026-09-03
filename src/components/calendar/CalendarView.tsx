"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  User,
  Video,
  X,
} from "lucide-react";
import {
  APPOINTMENT_TYPES,
  APPOINTMENT_TYPE_META,
  type Appointment,
  type AppointmentStatus,
  type AppointmentType,
  type CalendarData,
  type Practitioner,
} from "@/adapters/calendar.types";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type { LiveCalendar } from "@/adapters/live-types";
import type { Tone } from "@/adapters/types";
import { Btn } from "@/components/ui/Btn";
import { ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StartEncounterButton } from "@/components/encounter/StartEncounterButton";
import { CheckoutButton } from "@/components/billing/CheckoutButton";
import { Card } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { useFeedback } from "@/lib/feedback";
import { toneColor, toneText, toneTint } from "@/lib/tones";
import { calendarSlotFromOffset } from "./calendar-slot";

/* --------------------------------------------------------------- date utils */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** ISO weekday 1..7 (Mon..Sun). */
function isoWeekday(d: Date): number {
  return ((d.getDay() + 6) % 7) + 1;
}
function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - (isoWeekday(r) - 1));
  return r;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
function fmtDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtTimeInput(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ status helper */

/** Derive a lively status from the slot's real date/time vs. now. */

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  arrived: "Arrived",
  "in-encounter": "In room",
  completed: "Completed",
  "no-show": "No-show",
  cancelled: "Cancelled",
};

/* ----------------------------------------------------- live-mode mapping */

const KNOWN_TYPES = new Set<AppointmentType>(APPOINTMENT_TYPES.map((t) => t.type));
const LIVE_TONES: Tone[] = ["action", "teal", "positive", "ai", "navy", "warning"];

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

const STATUS_FROM_DB: Record<string, AppointmentStatus> = {
  scheduled: "scheduled",
  confirmed: "confirmed",
  arrived: "arrived",
  in_encounter: "in-encounter",
  completed: "completed",
  cancelled: "cancelled",
  no_show: "no-show",
};

/** Transition target (database vocabulary) → the client status label key. */
const DB_TO_CLIENT_STATUS: Record<
  "arrived" | "in_encounter" | "completed" | "cancelled" | "no_show",
  AppointmentStatus
> = {
  arrived: "arrived",
  in_encounter: "in-encounter",
  completed: "completed",
  cancelled: "cancelled",
  no_show: "no-show",
};

/** Front-desk action button styling (shared by the drawer's transition row). */
const FD_BTN =
  "flex h-8 flex-1 items-center justify-center rounded-lg border border-line bg-card px-2 text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50";
const FD_BTN_DANGER =
  "flex h-8 flex-1 items-center justify-center rounded-lg border border-line bg-card px-2 text-[12px] font-semibold text-critical hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50";

/**
 * Shape a live week (real, dated appointments) into the grid's CalendarData +
 * a per-appointment REAL status map (live status comes from the record, never
 * derived from the clock). Cancelled / no-show rows are hidden from the grid.
 */
function mapLiveWeek(live: LiveCalendar): {
  data: CalendarData;
  statusById: Map<string, AppointmentStatus>;
  /** Optimistic-concurrency token per appointment, straight from the record. */
  versionById: Map<string, number>;
  patients: LiveCalendar["patients"];
} {
  const statusById = new Map<string, AppointmentStatus>();
  const versionById = new Map<string, number>();
  const appointments: Appointment[] = [];
  let minStart = 8 * 60;
  let maxEnd = 18 * 60;

  for (const a of live.appointments) {
    const status = STATUS_FROM_DB[a.status] ?? "scheduled";
    if (!a.startsAt || !a.endsAt || status === "cancelled" || status === "no-show") continue;
    const startDate = new Date(a.startsAt);
    const endDate = new Date(a.endsAt);
    const start = startDate.getHours() * 60 + startDate.getMinutes();
    const durationMin = Math.max(Math.round((endDate.getTime() - startDate.getTime()) / 60_000), 5);
    const type: AppointmentType = KNOWN_TYPES.has(a.appointmentType as AppointmentType)
      ? (a.appointmentType as AppointmentType)
      : "follow-up";

    statusById.set(a.id, status);
    versionById.set(a.id, typeof a.version === "number" ? a.version : 1);
    appointments.push({
      id: a.id,
      practitionerId: a.practitionerUserId ?? "unknown",
      weekday: isoWeekday(startDate),
      start,
      durationMin,
      type,
      patientName: a.patientName ?? a.title ?? APPOINTMENT_TYPE_META[type].label,
      patientId: a.patientId ?? undefined,
      location: a.location ?? (a.telehealthUrl ? "Telehealth" : "—"),
    });
    minStart = Math.min(minStart, start);
    maxEnd = Math.max(maxEnd, start + durationMin);
  }

  const seen = new Set(live.practitioners.map((p) => p.userId));
  const practitioners: Practitioner[] = live.practitioners.map((p, i) => ({
    id: p.userId,
    name: p.displayName ?? "Practitioner",
    role: p.credentials ?? p.specialty ?? "Practitioner",
    initials: initialsOf(p.displayName ?? "P"),
    tone: LIVE_TONES[i % LIVE_TONES.length],
  }));
  // Appointments can reference members without a practitioner profile yet.
  for (const a of live.appointments) {
    if (a.practitionerUserId && !seen.has(a.practitionerUserId)) {
      seen.add(a.practitionerUserId);
      practitioners.push({
        id: a.practitionerUserId,
        name: a.practitionerName ?? "Practitioner",
        role: "Practitioner",
        initials: initialsOf(a.practitionerName ?? "P"),
        tone: LIVE_TONES[practitioners.length % LIVE_TONES.length],
      });
    }
  }
  if (practitioners.length === 0) {
    practitioners.push({ id: "unknown", name: "Practitioner", role: "—", initials: "P", tone: "action" });
  }

  return {
    data: {
      practitioners,
      appointments,
      dayStart: Math.floor(minStart / 60) * 60,
      dayEnd: Math.ceil(maxEnd / 60) * 60,
    },
    statusById,
    versionById,
    patients: live.patients,
  };
}

type TelehealthCalendarRow = {
  appointmentId: string | null;
  consumerPersonId: string;
  status: "requested" | "awaiting_provider" | "scheduled" | "reschedule_requested" | "cancelled";
  scheduledStart: string | null;
  scheduledEnd: string | null;
  joinUrl: string | null;
  version: number;
};

async function addTelehealthAppointments(week: LiveCalendar): Promise<LiveCalendar> {
  const response = await fetch("/api/live/telehealth-requests", { cache: "no-store" });
  const payload = await response.json().catch(() => null) as { data?: unknown } | null;
  // Patient-booked telehealth visits supplement the established clinical
  // calendar. A separately deployed appointment service must never blank the
  // practitioner calendar when it is unavailable, not yet deployed, or the
  // session boundary refuses that secondary request. The telehealth queue
  // remains the explicit place to diagnose and retry that service.
  if (!response.ok) return week;
  if (!Array.isArray(payload?.data)) throw new Error("The telehealth calendar response was invalid.");
  const ids = new Set(week.appointments.map((appointment) => appointment.id));
  const appointments = [...week.appointments];
  for (const candidate of payload.data) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Partial<TelehealthCalendarRow>;
    if (!row.appointmentId || ids.has(row.appointmentId) || !row.scheduledStart || !row.scheduledEnd || row.status === "cancelled") continue;
    ids.add(row.appointmentId);
    appointments.push({
      id: row.appointmentId,
      patientId: null,
      patientName: `Consumer ${String(row.consumerPersonId ?? "").slice(0, 8)}…`,
      practitionerUserId: null,
      practitionerName: null,
      title: "Patient-booked telehealth visit",
      appointmentType: "telehealth",
      location: "Telehealth",
      telehealthUrl: typeof row.joinUrl === "string" ? row.joinUrl : null,
      status: row.status === "scheduled" ? "confirmed" : "scheduled",
      version: typeof row.version === "number" ? row.version : 1,
      startsAt: row.scheduledStart,
      endsAt: row.scheduledEnd,
    });
  }
  return { ...week, appointments };
}

/* ------------------------------------------------------------- root screen */

type ViewMode = "week" | "day";

interface Selection {
  appt: Appointment;
  date: Date;
  status: AppointmentStatus;
}

interface BookingSeed {
  date: Date;
  startMin: number;
  practitionerId: string;
}

const HOUR_PX = 54;

export function CalendarView({
  initialApptId,
  initialCalendar = null,
}: {
  /** Deep link (?appt=) that opens the detail drawer on load. */
  initialApptId?: string;
  /** Server-loaded window so a transient browser bridge failure cannot blank the calendar. */
  initialCalendar?: LiveCalendar | null;
}) {
  // Live only: the anchored week is fetched from the record per anchor change.
  const [liveWeek, setLiveWeek] = useState<ReturnType<typeof mapLiveWeek> | null>(null);
  const [liveState, setLiveState] = useState<"loading" | "ready" | "error">("loading");
  const [liveError, setLiveError] = useState<{ message: string; code?: string }>({ message: "" });
  const [reloadKey, setReloadKey] = useState(0);
  const [bookingSeed, setBookingSeed] = useState<BookingSeed | null>(null);

  const [now, setNow] = useState<Date | null>(null);
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [view, setView] = useState<ViewMode>("week");
  const [practitionerId, setPractitionerId] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const deepLinked = useRef(false);
  const initialCalendarRef = useRef(initialCalendar);

  // Resolve "now" on the client only (avoids hydration mismatch from the clock).
  useEffect(() => {
    const d = new Date();
    setNow(d);
    setAnchor(d);
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Fetch the anchored week through the registry (RLS-scoped read).
  const weekStartIso = anchor ? startOfWeek(anchor).toISOString() : null;
  useEffect(() => {
    if (!weekStartIso) return;
    let alive = true;
    const from = new Date(weekStartIso);
    const to = addDays(from, 7);
    const serverWindow = initialCalendarRef.current;
    if (serverWindow && reloadKey === 0) {
      initialCalendarRef.current = null;
      const exactWeek = {
        ...serverWindow,
        appointments: serverWindow.appointments.filter((appointment) => {
          if (!appointment.startsAt) return false;
          const startsAt = Date.parse(appointment.startsAt);
          return Number.isFinite(startsAt) && startsAt >= from.getTime() && startsAt < to.getTime();
        }),
      };
      setLiveWeek(mapLiveWeek(exactWeek));
      setLiveState("ready");
      // The secondary telehealth service enriches the already-visible calendar;
      // its availability never controls whether the main calendar renders.
      addTelehealthAppointments(exactWeek).then((week) => {
        if (alive) setLiveWeek(mapLiveWeek(week));
      }).catch(() => undefined);
      return () => { alive = false; };
    }
    setLiveState("loading");
    api.schedule
      .getWeek(from.toISOString(), to.toISOString())
      .then(addTelehealthAppointments)
      .then((week) => {
        if (!alive) return;
        setLiveWeek(mapLiveWeek(week));
        setLiveState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setLiveError({
          message: isAdapterError(e) ? e.safeMessage : "Unable to load the calendar right now.",
          code: isAdapterError(e) ? e.code : undefined,
        });
        setLiveState("error");
      });
    return () => {
      alive = false;
    };
  }, [weekStartIso, reloadKey]);

  const data = liveWeek?.data ?? null;

  // ?appt= deep link (Today, patient tabs): open the matching appointment in
  // both demo and live mode once the anchored week has loaded.
  useEffect(() => {
    if (deepLinked.current || !initialApptId || !data || !anchor) return;
    const appt = data.appointments.find((item) => item.id === initialApptId);
    if (!appt) return;
    deepLinked.current = true;
    const date = addDays(startOfWeek(anchor), appt.weekday - 1);
    const status = liveWeek?.statusById.get(appt.id) ?? "scheduled";
    setSelection({ appt, date, status });
  }, [initialApptId, data, anchor, liveWeek]);

  // Keep the practitioner filter valid as live weeks load.
  useEffect(() => {
    if (data && !data.practitioners.some((p) => p.id === practitionerId)) {
      setPractitionerId(data.practitioners[0]?.id ?? "");
    }
  }, [data, practitionerId]);

  if (!anchor || !now) {
    return (
      <section data-screen-label="Calendar" className="px-5 pt-4 pb-8">
        <div className="h-[70vh] animate-pulse rounded-2xl bg-sunken" aria-hidden />
      </section>
    );
  }

  if (liveState === "error") {
    const signedOut = liveError.code === "unauthenticated";
    return (
      <section data-screen-label="Calendar" className="px-5 pt-4 pb-8">
        <ClinicalError
          message={liveError.message}
          onRetry={() => setReloadKey((k) => k + 1)}
          actionHref={signedOut ? "/login" : undefined}
          actionLabel={signedOut ? "Sign in" : undefined}
        />
      </section>
    );
  }
  if (liveState === "loading" || !data) {
    return (
      <section data-screen-label="Calendar" className="px-5 pt-4 pb-8">
        <ClinicalLoading label="Loading calendar…" />
      </section>
    );
  }
  if (!data) return null;

  const statusOf = (appt: Appointment): AppointmentStatus =>
    liveWeek?.statusById.get(appt.id) ?? "scheduled";

  const onChanged = () => {
    setSelection(null);
    setBookingSeed(null);
    setReloadKey((k) => k + 1);
  };

  const weekStart = startOfWeek(anchor);
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const hours = Array.from(
    { length: Math.ceil((data.dayEnd - data.dayStart) / 60) },
    (_, i) => data.dayStart / 60 + i,
  );
  const gridHeight = ((data.dayEnd - data.dayStart) / 60) * HOUR_PX;
  const pxPerMin = HOUR_PX / 60;

  const rangeLabel =
    view === "day"
      ? `${WEEKDAYS[isoWeekday(anchor) - 1]}, ${MONTHS[anchor.getMonth()]} ${anchor.getDate()}`
      : `${MONTHS[weekStart.getMonth()].slice(0, 3)} ${weekStart.getDate()} – ${
          weekStart.getMonth() === weekDates[6].getMonth()
            ? weekDates[6].getDate()
            : `${MONTHS[weekDates[6].getMonth()].slice(0, 3)} ${weekDates[6].getDate()}`
        }, ${weekDates[6].getFullYear()}`;

  const step = view === "day" ? 1 : 7;
  const go = (dir: -1 | 1) => setAnchor(addDays(anchor, dir * step));

  return (
    <section data-screen-label="Calendar" className="px-5 pt-4 pb-8">
      <Toolbar
        rangeLabel={rangeLabel}
        view={view}
        setView={setView}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
        onToday={() => setAnchor(new Date())}
        practitioners={data.practitioners}
        practitionerId={practitionerId}
        setPractitionerId={setPractitionerId}
        showPractitioner={view === "week"}
        onNew={() => setBookingSeed({
          date: anchor,
          startMin: 9 * 60,
          practitionerId: practitionerId || data.practitioners[0]?.id || "",
        })}
      />

      <div className="mt-3 grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4">
        <SideRail
          anchor={anchor}
          now={now}
          onPickDay={(d) => {
            setAnchor(d);
            setView("day");
          }}
        />

        <Card className="overflow-hidden p-0">
          {view === "week" ? (
            <WeekGrid
              data={data}
              weekDates={weekDates}
              hours={hours}
              gridHeight={gridHeight}
              pxPerMin={pxPerMin}
              now={now}
              practitionerId={practitionerId}
              statusOf={statusOf}
              onSelect={setSelection}
              onCreate={setBookingSeed}
            />
          ) : (
            <DayGrid
              data={data}
              date={anchor}
              hours={hours}
              gridHeight={gridHeight}
              pxPerMin={pxPerMin}
              now={now}
              statusOf={statusOf}
              onSelect={setSelection}
              onCreate={setBookingSeed}
            />
          )}
        </Card>
      </div>

      {selection && (
        <DetailDrawer
          selection={selection}
          data={data}
          version={liveWeek?.versionById.get(selection.appt.id) ?? null}
          onClose={() => setSelection(null)}
          onChanged={onChanged}
        />
      )}
      {bookingSeed && (
        <BookingDrawer
          practitioners={data.practitioners}
          patientOptions={liveWeek?.patients ?? []}
          defaultDate={bookingSeed.date}
          defaultStartMin={bookingSeed.startMin}
          defaultPractitionerId={bookingSeed.practitionerId}
          onClose={() => setBookingSeed(null)}
          onBooked={onChanged}
        />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- toolbar */

function Toolbar({
  rangeLabel,
  view,
  setView,
  onPrev,
  onNext,
  onToday,
  practitioners,
  practitionerId,
  setPractitionerId,
  showPractitioner,
  onNew,
}: {
  rangeLabel: string;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  practitioners: Practitioner[];
  practitionerId: string;
  setPractitionerId: (id: string) => void;
  showPractitioner: boolean;
  onNew: () => void;
}) {
  const btn =
    "flex h-8 items-center justify-center rounded-lg border border-line bg-card text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <button onClick={onToday} className={cn(btn, "px-3 text-[12.5px] font-semibold")}>
          Today
        </button>
        <div className="flex items-center">
          <button onClick={onPrev} aria-label="Previous" className={cn(btn, "w-8 rounded-r-none")}>
            <ChevronLeft size={15} strokeWidth={2} aria-hidden />
          </button>
          <button onClick={onNext} aria-label="Next" className={cn(btn, "w-8 rounded-l-none border-l-0")}>
            <ChevronRight size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <h1 className="m-0 ml-1 text-[17px] font-bold tracking-[-0.01em]">{rangeLabel}</h1>
      </div>

      <div className="flex items-center gap-2">
        {showPractitioner && (
          <label className="flex items-center gap-[6px]">
            <span className="sr-only">Practitioner</span>
            <select
              value={practitionerId}
              onChange={(e) => setPractitionerId(e.target.value)}
              className="h-8 rounded-lg border border-line bg-card px-[8px] text-[12.5px] font-medium text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
            >
              {practitioners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex items-center rounded-lg border border-line bg-card p-[2px]">
          {(["day", "week"] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "h-[26px] rounded-md px-[11px] text-[12px] font-semibold capitalize focus-visible:outline-2 focus-visible:outline-action",
                view === v ? "bg-action text-white" : "text-muted hover:text-ink",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <button
          onClick={onNew}
          className="flex h-8 items-center gap-[6px] rounded-lg border-none bg-action px-3 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <CalendarPlus size={14} strokeWidth={2} aria-hidden />
          New
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- siderail */

function SideRail({
  anchor,
  now,
  onPickDay,
}: {
  anchor: Date;
  now: Date;
  onPickDay: (d: Date) => void;
}) {
  const [monthCursor, setMonthCursor] = useState(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const lead = isoWeekday(first) - 1;
  const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(monthCursor.getFullYear(), monthCursor.getMonth(), i + 1)),
  ];

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-[11px]">
        <div className="mb-[6px] flex items-center justify-between">
          <span className="text-[12.5px] font-bold">
            {MONTHS[monthCursor.getMonth()]} {monthCursor.getFullYear()}
          </span>
          <span className="flex gap-1">
            <button
              aria-label="Previous month"
              onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}
              className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
            >
              <ChevronLeft size={14} strokeWidth={2} aria-hidden />
            </button>
            <button
              aria-label="Next month"
              onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}
              className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
            >
              <ChevronRight size={14} strokeWidth={2} aria-hidden />
            </button>
          </span>
        </div>
        <div className="grid grid-cols-7 gap-[2px] text-center">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <span key={i} className="py-[2px] text-[9.5px] font-bold text-faint">
              {d}
            </span>
          ))}
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const isToday = sameDay(d, now);
            const isActive = sameDay(d, anchor);
            return (
              <button
                key={i}
                onClick={() => onPickDay(d)}
                className={cn(
                  "flex h-[26px] items-center justify-center rounded-md text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-action",
                  isActive
                    ? "bg-action font-bold text-white"
                    : isToday
                      ? "bg-action-tint font-bold text-action-deep"
                      : "text-body hover:bg-sunken",
                )}
                aria-current={isToday ? "date" : undefined}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="p-[11px]">
        <h2 className="m-0 mb-[7px] text-[11.5px] font-bold">Appointment types</h2>
        <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
          {APPOINTMENT_TYPES.map((t) => (
            <li key={t.type} className="flex items-center gap-[7px]">
              <span
                className="h-[11px] w-[11px] shrink-0 rounded-[3px]"
                style={{ background: toneColor[t.tone] }}
                aria-hidden
              />
              <span className="text-[11.5px] text-body">{t.label}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- shared grid */

function HourGutter({ hours, gridHeight }: { hours: number[]; gridHeight: number }) {
  return (
    <div className="relative w-[56px] shrink-0" style={{ height: gridHeight }} aria-hidden>
      {hours.map((h, i) => (
        <div
          key={h}
          className="absolute right-[6px] -translate-y-1/2 text-[10px] font-medium text-faint"
          style={{ top: i * HOUR_PX }}
        >
          {i === 0 ? "" : fmtTime(h * 60)}
        </div>
      ))}
    </div>
  );
}

function HourLines({ hours }: { hours: number[] }) {
  return (
    <>
      {hours.map((h, i) => (
        <div
          key={h}
          className="pointer-events-none absolute right-0 left-0 border-t border-hairline-2"
          style={{ top: i * HOUR_PX }}
          aria-hidden
        />
      ))}
    </>
  );
}

function NowLine({ top }: { top: number }) {
  return (
    <div className="pointer-events-none absolute right-0 left-0 z-20" style={{ top }} aria-hidden>
      <div className="relative border-t-[1.5px] border-critical">
        <span className="absolute -top-[4px] -left-[4px] h-[8px] w-[8px] rounded-full bg-critical" />
      </div>
    </div>
  );
}

function AppointmentBlock({
  appt,
  date,
  status,
  pxPerMin,
  dayStart,
  onSelect,
  compact,
}: {
  appt: Appointment;
  date: Date;
  status: AppointmentStatus;
  pxPerMin: number;
  dayStart: number;
  onSelect: (s: Selection) => void;
  compact?: boolean;
}) {
  const meta = APPOINTMENT_TYPE_META[appt.type];
  const effective = status;
  const top = (appt.start - dayStart) * pxPerMin;
  const height = Math.max(appt.durationMin * pxPerMin - 3, 18);
  const done = effective === "completed" || effective === "cancelled" || effective === "no-show";
  const live = effective === "arrived";
  return (
    <button
      onClick={() => onSelect({ appt, date, status: effective })}
      data-calendar-appointment
      className={cn(
        "absolute right-[3px] left-[3px] z-10 overflow-hidden rounded-[7px] border-l-[3px] px-[7px] py-[3px] text-left transition focus-visible:z-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action",
        done ? "opacity-60" : "hover:brightness-[0.98]",
        live && "ring-2 ring-critical/50",
      )}
      style={{
        top,
        height,
        background: toneTint[meta.tone],
        borderColor: toneColor[meta.tone],
      }}
      title={`${meta.label} · ${appt.patientName} · ${fmtTime(appt.start)}`}
    >
      <div
        className="truncate text-[11px] font-bold leading-tight"
        style={{ color: toneText[meta.tone] }}
      >
        {appt.patientName}
      </div>
      {height > 30 && (
        <div className="mt-[1px] flex items-center gap-[4px] truncate text-[10px] text-muted">
          {appt.type === "telehealth" && <Video size={9} strokeWidth={2} aria-hidden />}
          <span className="truncate">
            {compact ? meta.short : `${fmtTime(appt.start)} · ${meta.short}`}
          </span>
        </div>
      )}
      {done && height > 30 && (
        <span className="absolute right-[5px] bottom-[3px] text-[8.5px] font-bold tracking-wide text-muted uppercase">
          ✓
        </span>
      )}
    </button>
  );
}

function EmptyColumnNote() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[16px] text-center text-[10.5px] text-ghost">
      No appointments
    </div>
  );
}

function CreateSlotButton({
  date,
  practitionerId,
  dayStart,
  dayEnd,
  pxPerMin,
  onCreate,
}: {
  date: Date;
  practitionerId: string;
  dayStart: number;
  dayEnd: number;
  pxPerMin: number;
  onCreate: (seed: BookingSeed) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Add an appointment or break on ${date.toLocaleDateString()}`}
      title="Click a time to add an appointment or break"
      className="absolute inset-0 z-0 cursor-crosshair border-0 bg-transparent p-0 hover:bg-action-tint/20 focus-visible:z-[5] focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-action"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const startMin = calendarSlotFromOffset(
          event.detail === 0 ? Number.NaN : event.clientY - rect.top,
          { dayStart, dayEnd, pxPerMin },
        );
        onCreate({ date, startMin, practitionerId });
      }}
    />
  );
}

/* --------------------------------------------------------------- week grid */

function WeekGrid({
  data,
  weekDates,
  hours,
  gridHeight,
  pxPerMin,
  now,
  practitionerId,
  statusOf,
  onSelect,
  onCreate,
}: {
  data: CalendarData;
  weekDates: Date[];
  hours: number[];
  gridHeight: number;
  pxPerMin: number;
  now: Date;
  practitionerId: string;
  statusOf: (appt: Appointment) => AppointmentStatus;
  onSelect: (s: Selection) => void;
  onCreate: (seed: BookingSeed) => void;
}) {
  const nowTop = (now.getHours() * 60 + now.getMinutes() - data.dayStart) * pxPerMin;
  const nowVisible = nowTop >= 0 && nowTop <= gridHeight;

  return (
    <div>
      {/* header row */}
      <div className="flex border-b border-hairline bg-[rgba(247,250,252,0.6)]">
        <div className="w-[56px] shrink-0" />
        {weekDates.map((d) => {
          const today = sameDay(d, now);
          return (
            <div
              key={d.toISOString()}
              className={cn(
                "flex-1 border-l border-hairline-2 px-2 py-[7px] text-center",
                today && "bg-action-tint",
              )}
            >
              <div className="text-[10px] font-semibold text-faint uppercase">
                {WEEKDAYS[isoWeekday(d) - 1]}
              </div>
              <div
                className={cn(
                  "mx-auto mt-[1px] flex h-[22px] w-[22px] items-center justify-center rounded-full text-[13px] font-bold",
                  today ? "bg-action text-white" : "text-ink",
                )}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* body */}
      <div className="flex max-h-[calc(100vh-220px)] overflow-y-auto">
        <HourGutter hours={hours} gridHeight={gridHeight} />
        <div className="flex flex-1">
          {weekDates.map((d) => {
            const weekday = isoWeekday(d);
            const appts = data.appointments.filter(
              (a) => a.practitionerId === practitionerId && a.weekday === weekday,
            );
            const today = sameDay(d, now);
            return (
              <div
                key={d.toISOString()}
                className="relative flex-1 border-l border-hairline-2"
                style={{ height: gridHeight }}
              >
                <HourLines hours={hours} />
                <CreateSlotButton
                  date={d}
                  practitionerId={practitionerId}
                  dayStart={data.dayStart}
                  dayEnd={data.dayEnd}
                  pxPerMin={pxPerMin}
                  onCreate={onCreate}
                />
                {appts.length === 0 && <EmptyColumnNote />}
                {appts.map((a) => (
                  <AppointmentBlock
                    key={a.id}
                    appt={a}
                    date={d}
                    status={statusOf(a)}
                    pxPerMin={pxPerMin}
                    dayStart={data.dayStart}
                    onSelect={onSelect}
                    compact
                  />
                ))}
                {today && nowVisible && <NowLine top={nowTop} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- day grid */

function DayGrid({
  data,
  date,
  hours,
  gridHeight,
  pxPerMin,
  now,
  statusOf,
  onSelect,
  onCreate,
}: {
  data: CalendarData;
  date: Date;
  hours: number[];
  gridHeight: number;
  pxPerMin: number;
  now: Date;
  statusOf: (appt: Appointment) => AppointmentStatus;
  onSelect: (s: Selection) => void;
  onCreate: (seed: BookingSeed) => void;
}) {
  const weekday = isoWeekday(date);
  const today = sameDay(date, now);
  const nowTop = (now.getHours() * 60 + now.getMinutes() - data.dayStart) * pxPerMin;
  const nowVisible = today && nowTop >= 0 && nowTop <= gridHeight;

  return (
    <div>
      <div className="flex border-b border-hairline bg-[rgba(247,250,252,0.6)]">
        <div className="w-[56px] shrink-0" />
        {data.practitioners.map((p) => (
          <div key={p.id} className="flex-1 border-l border-hairline-2 px-2 py-[8px] text-center">
            <div className="flex items-center justify-center gap-[6px]">
              <span
                className="flex h-[20px] w-[20px] items-center justify-center rounded-full text-[9.5px] font-bold text-white"
                style={{ background: toneColor[p.tone] }}
                aria-hidden
              >
                {p.initials}
              </span>
              <span className="text-[12px] font-bold text-ink">{p.name}</span>
            </div>
            <div className="text-[10px] text-subtle">{p.role}</div>
          </div>
        ))}
      </div>

      <div className="flex max-h-[calc(100vh-220px)] overflow-y-auto">
        <HourGutter hours={hours} gridHeight={gridHeight} />
        <div className="flex flex-1">
          {data.practitioners.map((p) => {
            const appts = data.appointments.filter(
              (a) => a.practitionerId === p.id && a.weekday === weekday,
            );
            return (
              <div
                key={p.id}
                className="relative flex-1 border-l border-hairline-2"
                style={{ height: gridHeight }}
              >
                <HourLines hours={hours} />
                <CreateSlotButton
                  date={date}
                  practitionerId={p.id}
                  dayStart={data.dayStart}
                  dayEnd={data.dayEnd}
                  pxPerMin={pxPerMin}
                  onCreate={onCreate}
                />
                {appts.length === 0 && <EmptyColumnNote />}
                {appts.map((a) => (
                  <AppointmentBlock
                    key={a.id}
                    appt={a}
                    date={date}
                    status={statusOf(a)}
                    pxPerMin={pxPerMin}
                    dayStart={data.dayStart}
                    onSelect={onSelect}
                  />
                ))}
                {nowVisible && <NowLine top={nowTop} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ detail drawer */


function StatusPill({ status }: { status: AppointmentStatus }) {
  const tone: Tone =
    status === "completed" ? "slate" : status === "arrived" ? "positive" : "action";
  return (
    <span
      className="rounded-full px-[9px] py-[2px] text-[10.5px] font-semibold"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function DetailDrawer({
  selection,
  data,
  version,
  onClose,
  onChanged,
}: {
  selection: Selection;
  data: CalendarData;
  /** Optimistic-concurrency token rendered with this appointment. */
  version: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { announce } = useFeedback();
  const { appt, date, status } = selection;
  const meta = APPOINTMENT_TYPE_META[appt.type];
  const practitioner = data.practitioners.find((p) => p.id === appt.practitionerId);
  const end = appt.start + appt.durationMin;
  const [working, setWorking] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<AppointmentStatus | null>(null);
  const [confirming, setConfirming] = useState<"cancelled" | "no_show" | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // The status actually on screen: the optimistic one while a transition is in
  // flight, otherwise the record's.
  const effectiveStatus: AppointmentStatus = optimisticStatus ?? status;
  const isSettled =
    effectiveStatus === "completed" ||
    effectiveStatus === "cancelled" ||
    effectiveStatus === "no-show";
  const isBooked = effectiveStatus === "scheduled" || effectiveStatus === "confirmed";
  const canArrive = isBooked;
  // start_encounter accepts scheduled / confirmed / arrived and transitions the
  // appointment to in_encounter itself, and re-opening an in-progress encounter
  // is legitimate. So the gate here is exactly "not settled" — matching the
  // server rather than being arbitrarily stricter than it.
  const canOpenEncounter = !isSettled;
  const canComplete = effectiveStatus === "arrived" || effectiveStatus === "in-encounter";
  // Checkout opens once the patient is actually here, and stays available
  // after the visit so a missed checkout can still be completed.
  const canCheckOut =
    effectiveStatus === "arrived" ||
    effectiveStatus === "in-encounter" ||
    effectiveStatus === "completed";
  const canReschedule = isBooked;
  const canNoShow = isBooked || effectiveStatus === "arrived";
  const canCancel = !isSettled;
  const [rescheduleDate, setRescheduleDate] = useState(() => fmtDateInput(date));
  const [rescheduleTime, setRescheduleTime] = useState(() => fmtTimeInput(appt.start));
  const [rescheduleError, setRescheduleError] = useState("");

  useEffect(() => {
    setWorking(false);
    setOptimisticStatus(null);
    setConfirming(null);
    setRescheduleOpen(false);
    setRescheduleDate(fmtDateInput(date));
    setRescheduleTime(fmtTimeInput(appt.start));
    setRescheduleError("");
  }, [appt.id, appt.start, date]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The front-desk state machine lives in the DATABASE. This sends the
  // transition with the version we rendered (so a concurrent change is a
  // conflict, not a silent clobber) and a stable idempotency key per
  // appointment+target (so a double click or a retried request applies once).
  // Optimistic status is shown immediately and rolled back on any failure.
  const runTransition = (
    target: "arrived" | "in_encounter" | "completed" | "cancelled" | "no_show",
  ) => {
    if (working) return;
    setWorking(true);
    setConfirming(null);
    setOptimisticStatus(DB_TO_CLIENT_STATUS[target]);
    api.schedule
      .transition({
        appointmentId: appt.id,
        toStatus: target,
        expectedVersion: version,
        idempotencyKey: `${appt.id}:${target}:${version ?? "nov"}`,
      })
      .then((r) => {
        announce(
          r.already_applied
            ? `Already ${r.status.replace("_", " ")} — no change made.`
            : `${STATUS_LABEL[DB_TO_CLIENT_STATUS[target]]} recorded. (saved to record + audit)`,
        );
        onChanged();
      })
      .catch((e) => {
        setWorking(false);
        setOptimisticStatus(null); // roll the optimistic UI back
        if (isAdapterError(e)) {
          announce(
            e.code === "conflict"
              ? "This appointment changed in another window. Reopen it to see the current status."
              : e.safeMessage,
          );
        } else {
          announce("Could not update the appointment. Nothing was saved.");
        }
      });
  };

  const saveReschedule = () => {
    if (working) return;
    setRescheduleError("");
    const starts = new Date(`${rescheduleDate}T${rescheduleTime}`);
    if (Number.isNaN(starts.getTime())) {
      setRescheduleError("Choose a valid date and start time.");
      return;
    }
    const ends = new Date(starts.getTime() + appt.durationMin * 60_000);
    setWorking(true);
    api.schedule
      .reschedule(appt.id, starts.toISOString(), ends.toISOString())
      .then((r) => {
        announce(`${r.message} (saved to record + audit)`);
        onChanged();
      })
      .catch((e) => {
        setWorking(false);
        setRescheduleError(
          isAdapterError(e)
            ? `${e.safeMessage}${e.code === "invalid" ? " The new time may overlap another appointment." : ""}`
            : "Could not reschedule the appointment.",
        );
      });
  };

  const Row = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
    <div className="flex items-start gap-[9px] px-4 py-[7px]">
      <span className="mt-[1px] shrink-0 text-faint">{icon}</span>
      <span className="text-[12.5px] text-body">{children}</span>
    </div>
  );

  return (
    <aside
      role="dialog"
      aria-label="Appointment details"
      className="glass-overlay animate-fade-up fixed top-3 right-3 bottom-3 z-[95] flex w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.97)] shadow-[0_20px_56px_rgba(24,42,61,0.2)]"
    >
      <div
        className="flex items-start gap-3 px-4 pt-[15px] pb-[13px]"
        style={{ borderBottom: `1px solid rgba(0,0,0,0.06)`, background: toneTint[meta.tone] }}
      >
        <span className="mt-[2px] h-[36px] w-[3px] shrink-0 rounded-full" style={{ background: toneColor[meta.tone] }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-ink">{appt.patientName}</div>
          <div className="text-[12px] font-semibold" style={{ color: toneText[meta.tone] }}>
            {meta.label}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-faint hover:bg-[rgba(90,107,126,0.12)] hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-[6px]">
        <div className="flex items-center gap-2 px-4 py-[8px]">
          <StatusPill status={effectiveStatus} />
        </div>
        <Row icon={<Clock size={14} strokeWidth={2} aria-hidden />}>
          {WEEKDAYS[isoWeekday(date) - 1]} {MONTHS[date.getMonth()].slice(0, 3)} {date.getDate()} ·{" "}
          {fmtTime(appt.start)} – {fmtTime(end)} ({appt.durationMin} min)
        </Row>
        {practitioner && (
          <Row icon={<User size={14} strokeWidth={2} aria-hidden />}>
            {practitioner.name} · {practitioner.role}
          </Row>
        )}
        <Row icon={appt.type === "telehealth" ? <Video size={14} strokeWidth={2} aria-hidden /> : <MapPin size={14} strokeWidth={2} aria-hidden />}>
          {appt.location}
        </Row>
      </div>

      <div className="flex flex-col gap-2 border-t border-hairline bg-[rgba(247,250,252,0.7)] p-3">
        {appt.patientId && (
          <Link
            href={`/patients/${appt.patientId}/supplements`}
            className="flex h-9 items-center justify-center gap-[7px] rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Open chart & add to order →
          </Link>
        )}
            {rescheduleOpen && canReschedule && (
              <div className="rounded-lg border border-line bg-card p-3">
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
                    Date
                    <input
                      aria-label="Reschedule date"
                      type="date"
                      value={rescheduleDate}
                      onChange={(e) => setRescheduleDate(e.target.value)}
                      className="mt-1 h-8 w-full rounded-lg border border-line bg-card px-2 text-[12px] font-medium text-body"
                    />
                  </label>
                  <label className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
                    Start time
                    <input
                      aria-label="Reschedule start time"
                      type="time"
                      value={rescheduleTime}
                      onChange={(e) => setRescheduleTime(e.target.value)}
                      className="mt-1 h-8 w-full rounded-lg border border-line bg-card px-2 text-[12px] font-medium text-body"
                    />
                  </label>
                </div>
                <p className="m-0 mt-2 text-[10.5px] text-subtle">
                  Duration stays {appt.durationMin} minutes. Conflicts are rejected before saving.
                </p>
                {rescheduleError && (
                  <p role="alert" className="m-0 mt-2 text-[11px] font-medium text-critical">
                    {rescheduleError}
                  </p>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <Btn size="sm" variant="ghost" onClick={() => setRescheduleOpen(false)}>
                    Close
                  </Btn>
                  <Btn size="sm" variant="primary" disabled={working} onClick={saveReschedule}>
                    {working ? "Saving…" : "Save new time"}
                  </Btn>
                </div>
              </div>
            )}
            {/* Context-sensitive actions: each button appears only when the
                database would ACCEPT that transition from the current status.
                The machine is authoritative — this list mirrors it, and an
                invalid attempt would still be refused server-side. */}
            <div className="flex flex-wrap gap-2">
              {canArrive && (
                <button
                  onClick={() => runTransition("arrived")}
                  disabled={working}
                  data-testid="appt-arrive"
                  className={FD_BTN}
                >
                  {working ? "Saving…" : "Arrive"}
                </button>
              )}
              {canOpenEncounter && appt.patientId && (
                <StartEncounterButton
                  patientId={appt.patientId}
                  appointmentId={appt.id}
                  visitType={appt.type === "telehealth" ? "telehealth" : "follow-up"}
                  label="Open encounter"
                />
              )}
              {canComplete && (
                <button
                  onClick={() => runTransition("completed")}
                  disabled={working}
                  data-testid="appt-complete"
                  className={FD_BTN}
                >
                  {working ? "Saving…" : "Complete"}
                </button>
              )}
              {canCheckOut && appt.patientId && (
                <CheckoutButton
                  patientId={appt.patientId}
                  appointmentId={appt.id}
                  className={FD_BTN}
                />
              )}
              {canReschedule && (
                <button
                  onClick={() => setRescheduleOpen((open) => !open)}
                  disabled={working}
                  data-testid="appt-reschedule"
                  className={FD_BTN}
                >
                  Reschedule
                </button>
              )}
              {canNoShow && (
                <button
                  onClick={() => setConfirming("no_show")}
                  disabled={working}
                  data-testid="appt-no-show"
                  className={FD_BTN_DANGER}
                >
                  No-show
                </button>
              )}
              {canCancel && (
                <button
                  onClick={() => setConfirming("cancelled")}
                  disabled={working}
                  data-testid="appt-cancel"
                  className={FD_BTN_DANGER}
                >
                  Cancel appt
                </button>
              )}
              {isSettled && (
                <p className="m-0 w-full text-[11px] leading-[1.5] text-faint">
                  This appointment is settled ({STATUS_LABEL[effectiveStatus].toLowerCase()}).
                  Changing it requires an administrator correction, which is recorded with a
                  reason.
                </p>
              )}
            </div>
      </div>

      <ConfirmDialog
        open={confirming != null}
        title={confirming === "no_show" ? "Mark as no-show?" : "Cancel this appointment?"}
        body={`${appt.patientName} · ${fmtTime(appt.start)}. This updates the appointment record and is audited.`}
        confirmLabel={confirming === "no_show" ? "Mark no-show" : "Cancel appointment"}
        destructive
        onConfirm={() => confirming && runTransition(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </aside>
  );
}

/* ----------------------------------------------------------- booking drawer */

/** LIVE booking: real appointment through book_appointment (0017, audited). */
function BookingDrawer({
  practitioners,
  patientOptions,
  defaultDate,
  defaultStartMin,
  defaultPractitionerId,
  onClose,
  onBooked,
}: {
  practitioners: Practitioner[];
  patientOptions: { id: string; name: string }[];
  defaultDate: Date;
  defaultStartMin: number;
  defaultPractitionerId: string;
  onClose: () => void;
  onBooked: () => void;
}) {
  const { announce } = useFeedback();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [patientId, setPatientId] = useState(patientOptions[0]?.id ?? "");
  const [practitionerId, setPractitionerId] = useState(
    defaultPractitionerId || practitioners[0]?.id || "",
  );
  const [type, setType] = useState<AppointmentType>("follow-up");
  const [dateStr, setDateStr] = useState(fmtDateInput(defaultDate));
  const [timeStr, setTimeStr] = useState(fmtTimeInput(defaultStartMin));
  const [durationMin, setDurationMin] = useState(45);
  const [location, setLocation] = useState("");
  const [working, setWorking] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needsPatient = type !== "break" && type !== "group";
  const field =
    "h-9 w-full rounded-lg border border-line bg-card px-[10px] text-[12.5px] text-body outline-none focus-visible:border-action focus-visible:outline-2 focus-visible:outline-action";
  const labelCls = "mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase";

  const submit = () => {
    if (working) return;
    setErrorMsg("");
    if (needsPatient && !patientId) {
      setErrorMsg("Choose a patient for this appointment type.");
      return;
    }
    const starts = new Date(`${dateStr}T${timeStr}`);
    if (Number.isNaN(starts.getTime())) {
      setErrorMsg("Choose a valid date and time.");
      return;
    }
    const ends = new Date(starts.getTime() + durationMin * 60_000);
    setWorking(true);
    api.schedule
      .book({
        practitionerUserId: practitionerId,
        appointmentType: type,
        startsAtIso: starts.toISOString(),
        endsAtIso: ends.toISOString(),
        patientId: needsPatient ? patientId : undefined,
        location: location.trim() || undefined,
      })
      .then((r) => {
        announce(`${r.message} (saved to record + audit)`);
        onBooked();
      })
      .catch((e) => {
        setWorking(false);
        setErrorMsg(
          isAdapterError(e)
            ? `${e.safeMessage}${e.code === "invalid" ? " If the time overlaps an existing appointment, pick another slot." : ""}`
            : "Could not book the appointment.",
        );
      });
  };

  return (
    <aside
      role="dialog"
      aria-label="New appointment"
      className="glass-overlay animate-fade-up fixed top-3 right-3 bottom-3 z-[95] flex w-[380px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.97)] shadow-[0_20px_56px_rgba(24,42,61,0.2)]"
    >
      <div className="flex items-start gap-[9px] border-b border-hairline px-4 pt-[14px] pb-3">
        <span className="mt-px flex h-7 w-7 items-center justify-center rounded-lg bg-action-tint">
          <CalendarPlus size={14} strokeWidth={1.75} className="text-action" aria-hidden />
        </span>
        <div className="flex-1">
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-[14px] font-bold outline-none">New appointment</h2>
          <div className="text-[11px] text-subtle">Booked to the record — double-booking is rejected.</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close booking"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-faint hover:bg-[rgba(90,107,126,0.1)] hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-[12px] overflow-y-auto px-4 py-[13px]">
        <div>
          <label htmlFor="book-type" className={labelCls}>Type</label>
          <select id="book-type" value={type} onChange={(e) => setType(e.target.value as AppointmentType)} className={field}>
            {APPOINTMENT_TYPES.map((t) => (
              <option key={t.type} value={t.type}>{t.label}</option>
            ))}
          </select>
        </div>

        {needsPatient && (
          <div>
            <label htmlFor="book-patient" className={labelCls}>Patient</label>
            <select id="book-patient" value={patientId} onChange={(e) => setPatientId(e.target.value)} className={field}>
              {patientOptions.length === 0 && <option value="">No accessible patients</option>}
              {patientOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="book-practitioner" className={labelCls}>Practitioner</label>
          <select id="book-practitioner" value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)} className={field}>
            {practitioners.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-[10px]">
          <div>
            <label htmlFor="book-date" className={labelCls}>Date</label>
            <input id="book-date" type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} className={field} />
          </div>
          <div>
            <label htmlFor="book-time" className={labelCls}>Start time</label>
            <input id="book-time" type="time" value={timeStr} onChange={(e) => setTimeStr(e.target.value)} className={field} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-[10px]">
          <div>
            <label htmlFor="book-duration" className={labelCls}>Duration</label>
            <select id="book-duration" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} className={field}>
              {[15, 30, 45, 60, 90].map((m) => (
                <option key={m} value={m}>{m} min</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="book-location" className={labelCls}>Location</label>
            <input
              id="book-location"
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={type === "telehealth" ? "Telehealth" : "Room…"}
              className={field}
            />
          </div>
        </div>

        {errorMsg && (
          <p role="alert" className="m-0 rounded-[9px] bg-critical-tint px-[11px] py-[9px] text-[12px] font-medium text-critical">
            {errorMsg}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-3">
        <button
          onClick={submit}
          disabled={working || (needsPatient && !patientId)}
          className="h-9 w-full cursor-pointer rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working ? "Booking…" : "Book appointment"}
        </button>
      </div>
    </aside>
  );
}
