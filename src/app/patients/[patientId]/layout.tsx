import { notFound } from "next/navigation";
import { api } from "@/adapters";
import { getRequestSession } from "@/server/session";
import { PatientHeaderCard } from "@/components/patient/PatientHeaderCard";
import { PatientPicker } from "@/components/patient/PatientPicker";
import { PatientTabs } from "@/components/patient/PatientTabs";

export default async function PatientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  const patient = await api.patients.get(patientId, (await getRequestSession()).token);
  if (!patient) notFound();

  return (
    <section
      data-screen-label="Patient chart"
      className="relative mx-auto max-w-[1560px] px-[22px] pt-[14px] pb-5"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[11.5px] font-semibold text-faint">Workspace / Patients / {patient.name}</div>
        <PatientPicker currentId={patient.id} />
      </div>
      <PatientHeaderCard patient={patient} />
      <div className="mt-1 min-w-0">
        <PatientTabs patientId={patient.id} />
        {children}
      </div>
    </section>
  );
}
