import type { Metadata } from "next";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Templates — AI Longevity Pro" };

/**
 * Templates: no live backend yet. The route stays in the navigation and says so
 * honestly. Status: docs/clinical-runtime-migration.md.
 */
export default function TemplatesPage() {
  return (
    <section data-screen-label="Templates" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <ClinicalEmpty
        title="Templates aren't configured yet"
        message="The versioned template library has no live backend yet. Nothing is shown rather than synthetic templates."
      />
    </section>
  );
}
