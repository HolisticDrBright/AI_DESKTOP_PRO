import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { CampaignsScreen } from "@/components/campaigns/CampaignsScreen";

export const metadata: Metadata = { title: "Campaigns — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/** Email campaigns for program leads, read-only in this phase: counts from the campaign service, editing in its own dashboard. */
export default function CampaignsPage() {
  return (
    <section className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-8">
      <PageHeader crumb="Business / Campaigns" title="Campaigns"
        sub="Confirmed subscribers per program list and recent sends. Counts only; no names or addresses are shown here." />
      <CampaignsScreen />
    </section>
  );
}
