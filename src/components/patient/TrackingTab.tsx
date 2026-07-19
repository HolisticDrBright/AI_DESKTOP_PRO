import { SegTabs } from "@/components/ui/SegTabs";
import { HealthTwinMap } from "@/components/twin/HealthTwinMap";
import { Nof1Lab } from "@/components/nof1/Nof1Lab";
import {
  AssessmentsView,
  MindView,
  TwinTrajectories,
  WearablesView,
} from "@/components/patient/TrackingViews";
import { patientPath } from "@/lib/routes";

/**
 * Tracking & Experiments: the longitudinal systems model (twin),
 * N-of-1 experiments, wearables, Mind & Cognition, and assessments —
 * one tab, five URL-synced views.
 */
export function TrackingTab({
  patientId,
  patientName,
  view,
}: {
  patientId: string;
  patientName: string;
  view?: string;
}) {
  const valid = ["twin", "experiments", "wearables", "mind", "assessments"];
  const active = valid.includes(view ?? "") ? (view as string) : "twin";
  return (
    <div data-screen-label="Tracking & Experiments">
      <SegTabs
        basePath={patientPath(patientId, "tracking")}
        param="view"
        value={active}
        ariaLabel="Tracking sections"
        options={[
          { id: "twin", label: "Systems model" },
          { id: "experiments", label: "N-of-1 experiments" },
          { id: "wearables", label: "Wearables" },
          { id: "mind", label: "Mind & Cognition" },
          { id: "assessments", label: "Assessments" },
        ]}
      />
      {active === "twin" && (
        <div className="flex flex-col gap-4">
          <TwinTrajectories patientId={patientId} />
          <HealthTwinMap patientId={patientId} patientName={patientName} />
        </div>
      )}
      {active === "experiments" && <Nof1Lab patientId={patientId} patientName={patientName} />}
      {active === "wearables" && <WearablesView patientId={patientId} />}
      {active === "mind" && <MindView patientId={patientId} />}
      {active === "assessments" && <AssessmentsView patientId={patientId} />}
    </div>
  );
}
