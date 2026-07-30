import type { Metadata } from "next";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Programs — AI Longevity Pro" };

/**
 * Programs: no live backend yet. The route (and its place in the navigation)
 * stays, and it says so honestly — it never renders the demo workspace.
 * Status: docs/clinical-runtime-migration.md.
 */
export default function ProgramsPage() {
  return (
    <section data-screen-label="Programs" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <ClinicalEmpty
        title="Programs aren't configured yet"
        message="The Programs Studio has no live catalog backend yet. Nothing is shown rather than synthetic programs, and nothing can be published from this screen."
      />
    </section>
  );
}
