import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { FinancialReports } from "@/components/plans/FinancialReports";

export const metadata: Metadata = { title: "Financial reports — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * Financial reporting. Every figure is summed by the database; anything that
 * is an estimate is labelled as one and is never called profit or revenue.
 */
export default function FinancialReportsPage() {
  return (
    <section data-screen-label="Financial reports" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Business / Billing / Reports"
        title="Financial reports"
        sub="Charges, collections, receivables, and sales over a chosen range."
      />
      <FinancialReports />
    </section>
  );
}
