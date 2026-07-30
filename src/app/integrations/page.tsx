import type { Metadata } from "next";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Integrations — AI Longevity Pro" };

/**
 * Integrations: no live backend yet. The route stays in the navigation and says so
 * honestly. Status: docs/clinical-runtime-migration.md.
 */
export default function IntegrationsPage() {
  return (
    <section data-screen-label="Integrations" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <ClinicalEmpty
        title="External integrations aren't configured yet"
        message="Connector management (EHR, labs, wearables, automations, webhooks) has no live backend yet. No connection is shown because none exists — this screen never fakes a connector."
      />
    </section>
  );
}
