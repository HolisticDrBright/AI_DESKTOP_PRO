import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/PageHeader';
import { OutreachStatusView } from '@/components/outreach/OutreachStatusView';
import { loadOutreachRows } from '@/server/outreach-status';
import { getRequestSession } from '@/server/session';

export const metadata: Metadata = { title: 'Outreach status — AI Longevity Pro' };
export const dynamic = 'force-dynamic';

/**
 * Every outreach setting on one read-only screen: program pages, campaign email, patient email and texts, and
 * purchase, each on, off or can't tell, with what it is waiting for. Read once per visit from this server's own
 * configuration, the repository's funnel definitions and the campaign engine's flags-only status read.
 */
export default async function OutreachStatusPage() {
  const session = await getRequestSession();
  const rows = await loadOutreachRows(session.token);
  return (
    <section className="mx-auto max-w-[1100px] px-[22px] pt-[18px] pb-8">
      <PageHeader crumb="Business / Outreach status" title="Outreach status"
        sub="What is switched on for program pages, campaign email, patient email and texts, and program purchase, and what each is waiting for." />
      <OutreachStatusView rows={rows} />
    </section>
  );
}
