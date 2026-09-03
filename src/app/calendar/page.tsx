import { CalendarView } from "@/components/calendar/CalendarView";
import { ClinicalNote } from "@/components/ui/ClinicalStates";
import { scheduleLive } from "@/adapters/schedule.live";
import { isAdapterError } from "@/adapters/errors";
import type { LiveCalendar } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";

/**
 * The live calendar response includes a scheduling-safe patient picker (id and
 * name only) alongside appointments and practitioners. `?appt=<id>` deep-links
 * from Today and patient tabs open the matching appointment drawer.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [sp, session] = await Promise.all([searchParams, getRequestSession()]);
  const initialApptId = typeof sp.appt === "string" ? sp.appt : undefined;
  let initialCalendar: LiveCalendar | null = null;
  if (session.token && session.orgId) {
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    try {
      initialCalendar = await scheduleLive.getCalendar(from.toISOString(), to.toISOString(), session.token, session.orgId);
    } catch (error) {
      console.warn("[calendar:ssr] unavailable", {
        code: isAdapterError(error) ? error.code : "unknown",
        detail: isAdapterError(error) ? error.detail : undefined,
      });
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="px-5 pt-4">
        <ClinicalNote>
          <strong>ALP clinical calendar.</strong> Appointments shown here are stored in the governed
          AWS clinical service. Google Calendar is not connected to this environment.
        </ClinicalNote>
      </div>
      <CalendarView initialApptId={initialApptId} initialCalendar={initialCalendar} />
    </div>
  );
}
