import { CalendarView } from "@/components/calendar/CalendarView";
import { api } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { getRequestSession } from "@/server/session";

/**
 * LIVE: bookable patients are fetched server-side under the practitioner's
 * RLS view and passed down, so the booking drawer never imports server-only
 * code. Demo mode renders the weekday-pattern mock with no options needed.
 * `?appt=<id>` deep-links (from Today / patient tabs) open the drawer.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialApptId = typeof sp.appt === "string" ? sp.appt : undefined;
  let patientOptions: { id: string; name: string }[] = [];
  if (USE_LIVE_API) {
    try {
      const session = await getRequestSession();
      const list = await api.patients.list(session.token, session.orgId);
      patientOptions = list.map((p) => ({ id: p.id, name: p.name }));
    } catch {
      // Signed-out / backend-down surfaces on the calendar itself.
    }
  }
  return <CalendarView patientOptions={patientOptions} initialApptId={initialApptId} />;
}
