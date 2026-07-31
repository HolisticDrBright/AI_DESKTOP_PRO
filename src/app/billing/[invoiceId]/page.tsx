import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { InvoiceDetail } from "@/components/billing/InvoiceDetail";

export const metadata: Metadata = { title: "Invoice — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/** One invoice: checkout while it is a draft, then payment and refunds. */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  return (
    <section data-screen-label="Invoice" className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-6">
      <PageHeader crumb="Business / Billing / Invoice" title="Invoice" />
      <InvoiceDetail invoiceId={invoiceId} />
    </section>
  );
}
