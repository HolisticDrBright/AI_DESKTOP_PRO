import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/PageHeader';
import { CampaignsScreen } from '@/components/campaigns/CampaignsScreen';
import { campaignEngineEnabled } from '@/server/campaign-api';

export const metadata: Metadata = { title: 'Campaigns — AI Longevity Pro' };
export const dynamic = 'force-dynamic';

/** Email campaigns to people who are not patients yet: the marketing package. Commercial data only. */
export default function CampaignsPage() {
  return (
    <section className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-8">
      <PageHeader crumb="Business / Campaigns" title="Campaigns" sub="Opt-in lists, welcome sequences and broadcasts for people who asked to hear about a program. Not for patients as patients." />
      <CampaignsScreen enabled={campaignEngineEnabled()} />
    </section>
  );
}
