import type { Metadata } from "next";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Reports — AI Longevity Pro" };

/**
 * Reports: no live backend yet. The route (and its place in the navigation)
 * stays, and it says so honestly — it never renders the demo workspace.
 * Status: docs/clinical-runtime-migration.md.
 */
export default function ReportsPage() {
  return (
    <section data-screen-label="Reports" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <ClinicalEmpty
        title="Reports aren't configured yet"
        message="Practice reports need real, access-scoped aggregate queries. Nothing is shown rather than synthetic aggregates."
      />
    </section>
  );
}
