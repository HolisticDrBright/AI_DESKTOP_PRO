import { CalendarView } from "@/components/calendar/CalendarView";
import { ClinicalNote } from "@/components/ui/ClinicalStates";

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
  return (
    <div className="flex flex-col gap-3">
      <div className="px-5 pt-4">
        <ClinicalNote>
          <strong>ALP clinical calendar.</strong> Appointments shown here are stored in the governed
          AWS clinical service. Google Calendar is not connected to this environment.
        </ClinicalNote>
      </div>
      <CalendarView initialApptId={initialApptId} />
    </div>
  );
}
