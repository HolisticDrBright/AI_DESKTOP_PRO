import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { api } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { getRequestSession } from "@/server/session";
import { PatientScreeningCard } from "@/components/patient/PatientScreeningCard";
import { SummaryTab } from "@/components/patient/summary/SummaryTab";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";
import { patientPath } from "@/lib/routes";

export default async function PatientSummaryPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  const [summary, patient] = await Promise.all([
    api.patients.summary(patientId),
    api.patients.get(patientId, (await getRequestSession()).token),
  ]);

  // LIVE: the patient (header, tabs, labs, tasks) is real. The synthesized
  // summary panels have no live data source yet — render an honest state
  // instead of a 404, and point at the tabs that ARE live.
  if (USE_LIVE_API) {
    if (!patient) notFound();
    return (
      <div className="pt-4">
        <ClinicalEmpty
          icon={<FlaskConical size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
          title="Summary panels aren't live yet"
          message="Health-score, systems, and trend panels are demo-only until their live data sources exist. Labs, Tasks, and the Calendar are live for this patient."
        />
        <p className="mt-3 text-center text-[12.5px]">
          <Link
            href={patientPath(patientId, "labs")}
            className="font-semibold text-action hover:underline focus-visible:outline-2 focus-visible:outline-action"
          >
            Open live labs →
          </Link>
        </p>
      </div>
    );
  }

  if (!summary) notFound();
  return (
    <>
      <div className="pt-4">
        <PatientScreeningCard patientId={patientId} />
      </div>
      <SummaryTab summary={summary} patientId={patientId} patientName={patient?.name} />
    </>
  );
}
