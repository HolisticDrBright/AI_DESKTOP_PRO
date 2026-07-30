import type { Metadata } from "next";
import { USE_LIVE_API } from "@/adapters/mode";
import { InboxWorkspace } from "@/components/inbox/InboxWorkspace";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Inbox — AI Longevity Pro" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const thread = typeof sp.thread === "string" ? sp.thread : undefined;
  const filter = typeof sp.filter === "string" ? sp.filter : undefined;

  if (USE_LIVE_API) {
    return (
      <section data-screen-label="Inbox" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
        <ClinicalEmpty
          title="Messaging isn't live yet"
          message="Secure patient messaging has no live backend; the demo workspace is mock-only and stays hidden in live mode rather than pretending to send."
        />
      </section>
    );
  }
  return <InboxWorkspace initialThread={thread} initialFilter={filter} />;
}
