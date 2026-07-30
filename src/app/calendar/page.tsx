import { CalendarView } from "@/components/calendar/CalendarView";

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
  const sp = await searchParams;
  const initialApptId = typeof sp.appt === "string" ? sp.appt : undefined;
  return <CalendarView initialApptId={initialApptId} />;
}
