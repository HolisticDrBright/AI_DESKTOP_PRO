import { SegTabs } from "@/components/ui/SegTabs";
import { LabsWorkspace } from "@/components/labs/LabsWorkspace";
import { LabOrdersWorkspace } from "@/components/laborders/LabOrdersWorkspace";
import { ReasoningWorkspace } from "@/components/reasoning/ReasoningWorkspace";
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
  const active = view === "orders" || view === "reasoning" ? view : "results";
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
        ]}
      />
      {active === "results" && <LabsWorkspace patientId={patientId} patientName={patientName} />}
      {active === "orders" && <LabOrdersWorkspace patientId={patientId} patientName={patientName} />}
      {active === "reasoning" && <ReasoningWorkspace patientId={patientId} patientName={patientName} />}
    </div>
  );
}
