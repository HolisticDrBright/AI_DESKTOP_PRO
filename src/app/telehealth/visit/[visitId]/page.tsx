import type { Metadata } from "next";
import { TelehealthVisitScreen } from "@/components/telehealth/TelehealthVisit";

export const metadata: Metadata = { title: "Telehealth visit — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/** `/telehealth/visit/[appointmentId]?date=YYYY-MM-DD` — the embedded Zoom visit. */
export default async function TelehealthVisitPage({
  params,
  searchParams,
}: {
  params: Promise<{ visitId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ visitId }, sp] = await Promise.all([params, searchParams]);
  const date = typeof sp.date === "string" ? sp.date : "";
  return <TelehealthVisitScreen appointmentId={visitId} date={date} />;
}
