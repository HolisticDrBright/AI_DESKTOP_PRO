import type { Metadata } from "next";
import { TelehealthDayView } from "@/components/telehealth/TelehealthDay";

export const metadata: Metadata = { title: "Telehealth — AI Longevity Pro" };

// The day view is request-time state — never prerender it at build time.
export const dynamic = "force-dynamic";

/** `/telehealth?date=YYYY-MM-DD` — defaults to the viewer's local day. */
export default async function TelehealthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const date = typeof sp.date === "string" ? sp.date : undefined;
  return <TelehealthDayView initialDate={date} />;
}
