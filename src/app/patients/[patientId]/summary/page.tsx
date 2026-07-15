import { notFound } from "next/navigation";
import { api } from "@/adapters";
import { SummaryTab } from "@/components/patient/summary/SummaryTab";

export default async function PatientSummaryPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  const [summary, patient] = await Promise.all([
    api.patients.summary(patientId),
    api.patients.get(patientId),
  ]);
  if (!summary) notFound();
  return (
    <SummaryTab summary={summary} patientId={patientId} patientName={patient?.name} />
  );
}
