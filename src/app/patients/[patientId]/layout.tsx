import { notFound } from "next/navigation";
import { api } from "@/adapters";
import { PatientHeaderCard } from "@/components/patient/PatientHeaderCard";
import { PatientTabs } from "@/components/patient/PatientTabs";
import { RightRail } from "@/components/patient/RightRail";

export default async function PatientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  const patient = await api.patients.get(patientId);
  if (!patient) notFound();
  const rail = await api.practice.rightRail();

  return (
    <section
      data-screen-label="Patient Overview"
      className="relative max-w-[1560px] px-[22px] pt-[18px] pb-5"
    >
      <PatientHeaderCard patient={patient} />
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_296px] items-start gap-[18px]">
        <div className="min-w-0">
          <PatientTabs patientId={patient.id} />
          {children}
        </div>
        <RightRail data={rail} />
      </div>
    </section>
  );
}
