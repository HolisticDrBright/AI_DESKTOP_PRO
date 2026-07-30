import { SegTabs } from "@/components/ui/SegTabs";
import { LabsWorkspace } from "@/components/labs/LabsWorkspace";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";
import { ReasoningWorkspace } from "@/components/reasoning/ReasoningWorkspace";
import { ClinicalCopilotWorkspace } from "@/components/patient/ClinicalCopilotWorkspace";
import { patientPath } from "@/lib/routes";

/**
 * Labs & Reasoning hub: results (labs workspace with extraction review,
 * trends, provenance), orders, and the clinical-reasoning workspace
 * (hypotheses, evidence, missing info, safety, differential questions) —
 * one tab, three URL-synced views. The underlying workspaces are the
 * existing, safeguard-complete components, unchanged.
 */
export function LabsHub({
  patientId,
  patientName,
  view,
}: {
  patientId: string;
  patientName: string;
  view?: string;
}) {
  const active =
    view === "orders" || view === "reasoning" || view === "copilot"
      ? view
      : "results";
  return (
    <div>
      <SegTabs
        basePath={patientPath(patientId, "labs")}
        param="view"
        value={active}
        ariaLabel="Labs and reasoning sections"
        options={[
          { id: "results", label: "Results & review" },
          { id: "orders", label: "Lab orders" },
          { id: "reasoning", label: "Clinical reasoning" },
          { id: "copilot", label: "Clinical copilot" },
        ]}
      />
      {active === "results" && <LabsWorkspace patientId={patientId} patientName={patientName} />}
      {active === "orders" && (
        <div className="pt-3">
          <ClinicalEmpty
            title="Lab ordering isn't configured yet"
            message="Ordering needs a real lab-vendor integration. No requisition can be created from this screen, and no catalog is shown rather than a synthetic one."
          />
        </div>
      )}
      {active === "reasoning" && <ReasoningWorkspace patientId={patientId} patientName={patientName} />}
      {active === "copilot" && <ClinicalCopilotWorkspace patientId={patientId} patientName={patientName} />}
    </div>
  );
}
