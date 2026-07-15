import { notFound } from "next/navigation";
import type { PatientTabId } from "@/adapters/types";
import { TabPlaceholderCard } from "@/components/patient/TabPlaceholderCard";
import { isPatientTabId } from "@/lib/routes";

const TAB_LABELS: Record<Exclude<PatientTabId, "summary">, string> = {
  twin: "Health Twin",
  timeline: "Timeline",
  labs: "Labs",
  reasoning: "Clinical Reasoning",
  supplements: "Supplements",
  "nof1-lab": "N-of-1 Lab",
  protocols: "Protocols",
  reports: "Reports",
};

export default async function PatientTabPage({
  params,
}: {
  params: Promise<{ patientId: string; tab: string }>;
}) {
  const { tab } = await params;
  if (!isPatientTabId(tab) || tab === "summary") notFound();
  return <TabPlaceholderCard label={TAB_LABELS[tab]} />;
}
