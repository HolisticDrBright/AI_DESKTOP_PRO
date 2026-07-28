import type { Metadata } from "next";
import { InventoryPanel } from "@/components/supplements/InventoryPanel";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Products & inventory — AI Longevity Pro" };

export default function CatalogSettingsPage() {
  return (
    <section data-screen-label="Products and inventory" className="mx-auto max-w-[1280px] px-6 pt-[18px] pb-8">
      <PageHeader
        crumb="Settings / Catalog & commerce"
        title="Products & inventory"
        sub="Maintain the dispensary catalog used by protocols, checkout, invoices, and low-stock review."
      />
      <InventoryPanel />
    </section>
  );
}
