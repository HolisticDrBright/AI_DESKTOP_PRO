import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { FunnelsScreen } from "@/components/funnels/FunnelsScreen";
import { allFunnels } from "@/funnels";
import { marketingSignupDirectory } from "@/funnels/marketingSignup";
import { funnelUpdatesUrl } from "@/lib/marketingSignupLink";

export const metadata: Metadata = { title: "Funnels — AI Longevity Pro" };
export const dynamic = "force-dynamic";

/**
 * The practitioner's view of the program funnels: which exist, which are public, where they
 * hand off, and whether that hand-off still works. Read-only in this phase; the definitions
 * live in the repository and change only through review.
 */
export default async function FunnelsPage() {
  const directory = marketingSignupDirectory();
  const updatesUrls = Object.fromEntries(await Promise.all(allFunnels().map(async funnel => [funnel.slug, await funnelUpdatesUrl(funnel, directory)] as const)));
  return (
    <section className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-8">
      <PageHeader crumb="Business / Funnels" title="Funnels"
        sub="Review program landing pages and consultation links. Direct program purchase is the requested next path; pricing and payment fulfillment remain unconfigured." />
      <FunnelsScreen updatesUrls={updatesUrls} />
    </section>
  );
}
