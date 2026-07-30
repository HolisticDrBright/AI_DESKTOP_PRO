import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Catalog — AI Longevity Pro" };

/** Products & services catalog: no live inventory backend yet. */
export default function CatalogSettingsPage() {
  return (
    <section data-screen-label="Catalog" className="mx-auto max-w-[900px] px-6 pt-[18px] pb-8">
      <PageHeader crumb="Settings / Catalog" title="Products & services" />
      <ClinicalEmpty
        title="The catalog isn't configured yet"
        message="Products, services, and inventory need a live backend. Nothing is shown rather than synthetic stock, and nothing can be sold from this screen."
      />
    </section>
  );
}
