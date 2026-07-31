import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { BillingWorkspace } from "@/components/billing/BillingWorkspace";
import { btnClass } from "@/components/ui/Btn";

export const metadata: Metadata = { title: "Billing — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * Practice billing. Every figure is summed by the database from persisted
 * invoices, payments, refunds, and stock movements — nothing here is
 * projected or estimated. Card payments are Stripe TEST MODE only.
 */
export default function BillingPage() {
  return (
    <section data-screen-label="Billing" className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Business / Billing"
        title="Billing"
        sub="Invoices, payments, receivables, and stock valuation for the practice."
        actions={
          <>
            <Link href="/billing/reports" className={btnClass("outline", "md")}>
              Reports
            </Link>
            <Link href="/billing/reconciliation" className={btnClass("outline", "md")}>
              Reconciliation
            </Link>
            <Link href="/settings/plans" className={btnClass("outline", "md")}>
              Plans
            </Link>
          </>
        }
      />
      <BillingWorkspace />
    </section>
  );
}
