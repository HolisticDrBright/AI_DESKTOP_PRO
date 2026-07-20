import { ClipboardList } from "lucide-react";
import { USE_LIVE_API } from "@/adapters/mode";
import { AssessmentsWorkspace } from "@/components/assessments/AssessmentsWorkspace";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export default function Page() {
  // LIVE: fail closed. The backend procedures exist (clinical.assessments.*,
  // clinical.recommendations.*, clinical.registry.* → RPCs in migration 0027),
  // but this desktop surface is not wired to them yet — so in live mode we say
  // exactly that instead of showing a demo that could be mistaken for live data.
  if (USE_LIVE_API) {
    return (
      <div className="pt-8">
        <ClinicalEmpty
          icon={<ClipboardList size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
          title="Assessments aren't wired to the live backend yet"
          message="The governed API (clinical.assessments / recommendations / registry) and database schema exist; this workspace connects to them in a follow-up. Demo mode (NEXT_PUBLIC_USE_LIVE_API unset) shows the full synthetic workflow."
        />
      </div>
    );
  }
  return <AssessmentsWorkspace />;
}
