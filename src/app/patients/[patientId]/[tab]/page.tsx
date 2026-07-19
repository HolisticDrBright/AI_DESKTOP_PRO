import { notFound, redirect } from "next/navigation";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { api } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { getRequestSession } from "@/server/session";
import { isPatientTabId, LEGACY_PATIENT_TABS, patientPath } from "@/lib/routes";
import type { PatientTabId } from "@/adapters/types";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";
import { PatientTimeline } from "@/components/encounter/PatientTimeline";
import { ProfileOverview } from "@/components/patient/ProfileOverview";
import { ChartTimeline } from "@/components/patient/ChartTimeline";
import { LabsHub } from "@/components/patient/LabsHub";
import { CarePlanTab } from "@/components/patient/CarePlanTab";
import { TrackingTab } from "@/components/patient/TrackingTab";
import { PatientAppointments } from "@/components/patient/PatientAppointments";
import { PatientMessagesTab } from "@/components/patient/PatientMessagesTab";
import { PatientBillingTab } from "@/components/patient/PatientBillingTab";
import { PatientFilesTab } from "@/components/patient/PatientFilesTab";

/** Tabs with live data sources; the rest state their demo-only status in live mode. */
const LIVE_READY: Partial<Record<PatientTabId, true>> = { chart: true, labs: true };

function LiveHold({ patientId, label }: { patientId: string; label: string }) {
  return (
    <div className="pt-4">
      <ClinicalEmpty
        icon={<FlaskConical size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
        title={`${label} isn't live yet`}
        message="This section is demo-only until its live data source exists. Labs, the chart timeline, Tasks, and the Calendar are live for this patient."
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

export default async function PatientTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string; tab: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { patientId, tab } = await params;

  // Pre-overhaul tab URLs stay alive (docs/information-architecture.md).
  const legacy = LEGACY_PATIENT_TABS[tab];
  if (legacy) {
    redirect(`/patients/${patientId}/${legacy.tab}${legacy.query ? `?${legacy.query}` : ""}`);
  }
  if (!isPatientTabId(tab)) notFound();

  const sp = await searchParams;
  const view = typeof sp.view === "string" ? sp.view : undefined;

  const patient = await api.patients.get(patientId, (await getRequestSession()).token);
  if (!patient) notFound();
  const name = patient.name;

  if (tab === "overview") {
    if (USE_LIVE_API) {
      // Live: header/tabs/labs/tasks are real; synthesized profile panels
      // aren't. Keep the honest state (and the live e2e contract strings).
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
    return <ProfileOverview patient={patient} />;
  }

  if (tab === "chart") {
    if (USE_LIVE_API) return <PatientTimeline patientId={patientId} />;
    return <ChartTimeline patientId={patientId} patientName={name} />;
  }

  if (tab === "labs") {
    return <LabsHub patientId={patientId} patientName={name} view={view} />;
  }

  if (USE_LIVE_API && !LIVE_READY[tab]) {
    const label =
      tab === "care-plan"
        ? "Care Plan"
        : tab === "tracking"
          ? "Tracking & Experiments"
          : tab.charAt(0).toUpperCase() + tab.slice(1);
    return <LiveHold patientId={patientId} label={label} />;
  }

  if (tab === "care-plan") return <CarePlanTab patientId={patientId} patientName={name} view={view} />;
  if (tab === "tracking") return <TrackingTab patientId={patientId} patientName={name} view={view} />;
  if (tab === "appointments") return <PatientAppointments patientId={patientId} patientName={name} />;
  if (tab === "messages") return <PatientMessagesTab patientId={patientId} />;
  if (tab === "billing") return <PatientBillingTab patientId={patientId} patientName={name} />;
  return <PatientFilesTab patientId={patientId} patientName={name} />;
}
