import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { FunnelsScreen } from "@/components/funnels/FunnelsScreen";

export const metadata: Metadata = { title: "Funnels — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * The practitioner's view of the program funnels: which exist, which are public, where they
 * hand off, and whether that hand-off still works. Read-only in this phase; the definitions
 * live in the repository and change only through review.
 */
export default function FunnelsPage() {
  return (
    <section className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-8">
      <PageHeader crumb="Business / Funnels" title="Funnels"
        sub="Public pages that describe a program and end in a consult request. No payment, no form and no health question lives on them; each hands off to one consult link." />
      <FunnelsScreen />
    </section>
  );
}
