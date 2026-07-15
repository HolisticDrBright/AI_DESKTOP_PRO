import { notFound } from "next/navigation";
import { api } from "@/adapters";
import type { PatientTabId } from "@/adapters/types";
import { TabPlaceholderCard } from "@/components/patient/TabPlaceholderCard";
import { LabsWorkspace } from "@/components/labs/LabsWorkspace";
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
  const { patientId, tab } = await params;
  if (!isPatientTabId(tab) || tab === "summary") notFound();

  if (tab === "labs") {
    const patient = await api.patients.get(patientId);
    return <LabsWorkspace patientId={patientId} patientName={patient?.name ?? "this patient"} />;
  }

  return <TabPlaceholderCard label={TAB_LABELS[tab]} />;
}
