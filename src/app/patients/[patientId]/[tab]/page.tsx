import { notFound, redirect } from "next/navigation";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { api } from "@/adapters";
import { getRequestSession } from "@/server/session";
import { isPatientTabId, LEGACY_PATIENT_TABS, patientPath } from "@/lib/routes";
import type { PatientTabId } from "@/adapters/types";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";
import { PatientTimeline } from "@/components/encounter/PatientTimeline";
import { PatientOverviewLive } from "@/components/patient/PatientOverviewLive";
import { LabsHub } from "@/components/patient/LabsHub";
import { ProtocolWorkspace } from "@/components/patient/ProtocolWorkspace";
import { PatientMessagesLive } from "@/components/inbox/PatientMessagesLive";
import { PatientSyncPanel } from "@/components/sync/PatientSyncPanel";

/** Tabs with live data sources; the rest state their demo-only status in live mode. */
const LIVE_READY: Partial<Record<PatientTabId, true>> = {
  chart: true,
  labs: true,
  protocol: true,
  messages: true,
  "app-sync": true,
};

function LiveHold({ patientId, label }: { patientId: string; label: string }) {
  return (
    <div className="pt-4">
      <ClinicalEmpty
        icon={<FlaskConical size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
        title={`${label} isn't live yet`}
        message="This section has no live data source yet. Labs, the chart timeline, the overview, Tasks, and the Calendar are live for this patient."
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
  const sp = await searchParams;
  const view = typeof sp.view === "string" ? sp.view : undefined;

  // The former nested Care Plan is now three visible patient tabs. Preserve
  // old bookmarks, including the nested view query, without hiding content.
  if (tab === "care-plan") {
    const destination = view === "supplements" ? "supplements" : view === "nutrition" ? "nutrition" : "protocol";
    redirect(`/patients/${patientId}/${destination}`);
  }

  // Pre-overhaul tab URLs stay alive (docs/information-architecture.md).
  const legacy = LEGACY_PATIENT_TABS[tab];
  if (legacy) {
    redirect(`/patients/${patientId}/${legacy.tab}${legacy.query ? `?${legacy.query}` : ""}`);
  }
  if (!isPatientTabId(tab)) notFound();

  const session = await getRequestSession();
  const patient = await api.patients.get(patientId, session.token, session.orgId);
  if (!patient) notFound();
  const name = patient.name;

  if (tab === "overview") {
    return <PatientOverviewLive patientId={patientId} />;
  }

  if (tab === "chart") {
    return <PatientTimeline patientId={patientId} />;
  }

  if (tab === "labs") {
    return <LabsHub patientId={patientId} patientName={name} view={view} />;
  }

  if (tab === "protocol") {
    return <ProtocolWorkspace patientId={patientId} />;
  }

  if (tab === "messages") {
    return <PatientMessagesLive patientId={patientId} />;
  }

  if (tab === "app-sync") {
    return <PatientSyncPanel patientId={patientId} />;
  }

  if (!LIVE_READY[tab]) {
    const label =
      tab === "nutrition"
          ? "Nutrition"
          : tab === "supplements"
            ? "Supplements"
        : tab === "tracking"
          ? "Tracking & Experiments"
          : tab.charAt(0).toUpperCase() + tab.slice(1);
    return <LiveHold patientId={patientId} label={label} />;
  }

  // Unreachable: every tab id is either live-ready or held above.
  notFound();
}
