import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";
import { SyncOperationsPanel } from "@/components/sync/SyncOperationsPanel";
import { FullscriptIntegrationPanel } from "@/components/integrations/FullscriptIntegrationPanel";

export const metadata: Metadata = { title: "Integrations — AI Longevity Pro" };

// Live, org-scoped operational state — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Integrations (phase 5): the patient-app synchronization operations surface
 * is REAL — provider posture, connected-patient counts, queues, dead letters,
 * and contract versions, all persisted rows. Every other connector family
 * (EHR, labs, wearables, automations, webhooks) still has no live backend and
 * says so honestly.
 */
export default function IntegrationsPage() {
  return (
    <section data-screen-label="Integrations" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Integrations"
        title="Integrations"
        sub="Patient-app synchronization operations and connector posture"
      />
      <SyncOperationsPanel />
      <FullscriptIntegrationPanel />
      <div className="mt-4">
        <ClinicalEmpty
          title="Other connector families aren't configured yet"
          message="EHR, other lab-vendor, wearable, automation, and general webhook connectors have no live backend yet. No connection is shown because none exists — this screen never fakes a connector."
        />
      </div>
    </section>
  );
}
