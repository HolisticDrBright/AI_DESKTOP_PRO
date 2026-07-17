import { USE_LIVE_API } from "@/adapters/mode";
import { EncounterWorkspace } from "@/components/encounter/EncounterWorkspace";
import { Card } from "@/components/ui/bits";

/**
 * Encounter workspace route (Phase 2 slice 1). Live mode only — the demo
 * dataset has no encounter records, and this workspace never fakes them.
 */
export default async function EncounterPage({
  params,
}: {
  params: Promise<{ patientId: string; encounterId: string }>;
}) {
  const { patientId, encounterId } = await params;

  if (!USE_LIVE_API) {
    return (
      <Card className="px-4 py-4">
        <p className="m-0 text-[13px] font-semibold text-ink">Encounters are a live-mode workspace</p>
        <p className="m-0 mt-1 text-[12.5px] leading-[1.5] text-subtle">
          The demo dataset has no encounter records. Run the app in live mode against the
          clinical backend to chart real visits.
        </p>
      </Card>
    );
  }

  return <EncounterWorkspace encounterId={encounterId} patientId={patientId} />;
}
