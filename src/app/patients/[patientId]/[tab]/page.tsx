import { notFound } from "next/navigation";
import { api } from "@/adapters";
import { getRequestSession } from "@/server/session";
import type { PatientTabId } from "@/adapters/types";
import { TabPlaceholderCard } from "@/components/patient/TabPlaceholderCard";
import { LabsWorkspace } from "@/components/labs/LabsWorkspace";
import { LabOrdersWorkspace } from "@/components/laborders/LabOrdersWorkspace";
import { ReasoningWorkspace } from "@/components/reasoning/ReasoningWorkspace";
import { SupplementsWorkspace } from "@/components/supplements/SupplementsWorkspace";
import { HealthTwinMap } from "@/components/twin/HealthTwinMap";
import { Nof1Lab } from "@/components/nof1/Nof1Lab";
import { isPatientTabId } from "@/lib/routes";

const TAB_LABELS: Record<Exclude<PatientTabId, "summary">, string> = {
  twin: "Health Twin",
  timeline: "Timeline",
  labs: "Labs",
  "lab-orders": "Lab Orders",
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

  const BUILT: Partial<Record<PatientTabId, boolean>> = {
    labs: true,
    "lab-orders": true,
    reasoning: true,
    supplements: true,
    twin: true,
    "nof1-lab": true,
  };

  if (BUILT[tab]) {
    const patient = await api.patients.get(patientId, (await getRequestSession()).token);
    const name = patient?.name ?? "this patient";
    if (tab === "labs") return <LabsWorkspace patientId={patientId} patientName={name} />;
    if (tab === "lab-orders") return <LabOrdersWorkspace patientId={patientId} patientName={name} />;
    if (tab === "reasoning") return <ReasoningWorkspace patientId={patientId} patientName={name} />;
    if (tab === "supplements") return <SupplementsWorkspace patientId={patientId} patientName={name} />;
    if (tab === "twin") return <HealthTwinMap patientId={patientId} patientName={name} />;
    if (tab === "nof1-lab") return <Nof1Lab patientId={patientId} patientName={name} />;
  }

  return <TabPlaceholderCard label={TAB_LABELS[tab]} />;
}
