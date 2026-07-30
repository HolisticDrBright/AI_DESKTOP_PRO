import type { Metadata } from "next";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Billing — AI Longevity Pro" };

/**
 * Billing: no live backend yet. The route (and its place in the navigation)
 * stays, and it says so honestly — it never renders the demo workspace.
 * Status: docs/clinical-runtime-migration.md.
 */
export default function BillingPage() {
  return (
    <section data-screen-label="Billing" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <ClinicalEmpty
        title="Billing isn't configured yet"
        message="Billing and payments have no live backend yet. Nothing is shown rather than synthetic invoices, and nothing can be charged from this screen."
      />
    </section>
  );
}
