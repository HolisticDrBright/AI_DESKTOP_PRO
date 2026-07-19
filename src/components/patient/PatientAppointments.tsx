"use client";

import { getCalendar, appointmentTitle } from "@/adapters/calendar.mock";
import { getApptOverride, statusLabel, STATUS_TONE, useApptSession } from "@/adapters/appointments.session";
import { getProfileExtras } from "@/adapters/patient-profile.mock";
import { Card, CardTitle } from "@/components/ui/bits";
import { BtnLink } from "@/components/ui/Btn";
import { Metric } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { DemoNote } from "@/components/ui/DemoNote";

const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtTime(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h = ((h24 + 11) % 12) + 1;
  return `${h}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Patient Appointments: upcoming (this week's template) + booking stats. */
export function PatientAppointments({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  useApptSession(); // subscribe so drawer actions update this tab
  const extras = getProfileExtras(patientId);
  const cal = getCalendar();
  const upcoming = cal.appointments
    .filter((a) => a.patientId === patientId)
    .sort((a, b) => a.weekday - b.weekday || a.start - b.start);

  return (
    <div data-screen-label="Appointments" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total bookings" value={extras.booking.total} sub={`Member since ${extras.booking.memberSinceLabel}`} />
        <Metric label="No-shows" value={extras.booking.noShows} subTone={extras.booking.noShows ? "warning" : undefined} sub={`${extras.booking.cancellations} cancellations`} />
        <Metric label="Last visit" value={extras.booking.lastVisitLabel} sub={`${extras.booking.sinceLastVisit} ago`} />
        <Metric label="Next" value={extras.booking.nextAppointmentLabel.split(" · ")[0] ?? "—"} sub={extras.booking.nextAppointmentLabel.split(" · ").slice(1).join(" · ") || "None scheduled"} href="/calendar" />
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-[10px]">
          <CardTitle className="flex-1">This week</CardTitle>
          <BtnLink size="sm" href="/calendar">Open calendar</BtnLink>
        </div>
        {upcoming.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-[12.5px] text-faint">
            No appointments in this week&apos;s template for {patientName}.
          </p>
        ) : (
          upcoming.map((a) => {
            const ov = getApptOverride(a.id);
            const pr = cal.practitioners.find((p) => p.id === a.practitionerId);
            return (
              <div key={a.id} className="flex items-center gap-3 border-b border-hairline px-4 py-[9px] last:border-b-0">
                <span className="w-[86px] shrink-0 text-[12px] font-semibold text-muted tabular-nums">
                  {DAY[a.weekday]} · {fmtTime(a.start)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{appointmentTitle(a.type)} · {a.durationMin} min</span>
                  <span className="block text-[11.5px] text-subtle">{pr?.name ?? "—"} · {a.location}</span>
                </span>
                {ov?.status ? (
                  <Pill tone={STATUS_TONE[ov.status]}>{statusLabel(ov.status)}{ov.rescheduledToLabel ? ` · ${ov.rescheduledToLabel}` : ""}</Pill>
                ) : (
                  <Pill tone="slate">Scheduled</Pill>
                )}
                <BtnLink size="sm" variant="ghost" href={`/calendar?appt=${a.id}`}>Open</BtnLink>
              </div>
            );
          })
        )}
      </Card>
      <DemoNote>
        The demo calendar is a recurring weekly template; front-desk changes made in the
        appointment drawer show here for this browser session. Live mode books real
        appointments through the backend with double-booking rejection and audit.
      </DemoNote>
    </div>
  );
}
