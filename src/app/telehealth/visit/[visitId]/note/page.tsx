import type { Metadata } from "next";
import { TelehealthNoteScreen } from "@/components/telehealth/TelehealthNote";

export const metadata: Metadata = { title: "Visit note — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/** `/telehealth/visit/[appointmentId]/note?date=YYYY-MM-DD` — the post-visit note. */
export default async function TelehealthNotePage({
  params,
  searchParams,
}: {
  params: Promise<{ visitId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ visitId }, sp] = await Promise.all([params, searchParams]);
  const date = typeof sp.date === "string" ? sp.date : "";
  return <TelehealthNoteScreen appointmentId={visitId} date={date} />;
}
