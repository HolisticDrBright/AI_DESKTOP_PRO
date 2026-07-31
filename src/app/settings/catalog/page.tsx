import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { CatalogWorkspace } from "@/components/settings/CatalogWorkspace";

export const metadata: Metadata = { title: "Catalog — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * Products, services, suppliers, locations, tax rates, and stock. Stock moves
 * only through receipts, reasoned adjustments, sales, and returns, so the
 * ledger always explains the current number.
 */
export default function CatalogSettingsPage() {
  return (
    <section data-screen-label="Catalog" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-8">
      <PageHeader
        crumb="Settings / Catalog"
        title="Products & services"
        sub="What the practice sells, what it costs, and what is on the shelf."
      />
      <CatalogWorkspace />
    </section>
  );
}
