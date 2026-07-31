import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ReconciliationWorkspace } from "@/components/plans/ReconciliationWorkspace";

export const metadata: Metadata = { title: "Reconciliation — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/** Internal payments against processor events, with reasoned resolution. */
export default function ReconciliationPage() {
  return (
    <section
      data-screen-label="Reconciliation"
      className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-6"
    >
      <PageHeader
        crumb="Business / Billing / Reconciliation"
        title="Reconciliation"
        sub="Where the practice's record and the processor's record disagree, and what was done about it."
      />
      <ReconciliationWorkspace />
    </section>
  );
}
