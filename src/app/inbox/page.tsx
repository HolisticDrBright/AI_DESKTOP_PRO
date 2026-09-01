import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxWorkspace } from "@/components/inbox/InboxWorkspace";

export const metadata: Metadata = { title: "Inbox — AI Longevity Pro" };

// Live, org-scoped data — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Inbox (phase 4): the real org-scoped communication workspace. Threads,
 * messages, drafts, assignments, and counts are persisted rows read and
 * written exclusively through the Desktop-owned RPC boundary. Sending fails
 * closed — no delivery provider is configured, so nothing on this screen can
 * claim a message was sent, delivered, or read by the patient app.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const thread = typeof sp.thread === "string" ? sp.thread : undefined;
  return (
    <section data-screen-label="Inbox" className="mx-auto max-w-[1360px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Inbox"
        title="Inbox"
        sub="Org-scoped patient communication — threads, drafts, triage, and workflow"
      />
      <div className="mb-4"><a className="inline-flex rounded-lg border px-3 py-2 text-sm font-semibold text-primary" href="/telehealth-requests">Open telehealth scheduling requests</a></div>
      <InboxWorkspace initialThreadId={thread} />
    </section>
  );
}
