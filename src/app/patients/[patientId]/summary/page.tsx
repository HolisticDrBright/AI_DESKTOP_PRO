import { notFound } from "next/navigation";
import { api } from "@/adapters";
import { SummaryTab } from "@/components/patient/summary/SummaryTab";

export default async function PatientSummaryPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  const summary = await api.patients.summary(patientId);
  if (!summary) notFound();
  return <SummaryTab summary={summary} patientId={patientId} />;
}
