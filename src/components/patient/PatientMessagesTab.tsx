"use client";

import Link from "next/link";
import { useInboxThreads } from "@/adapters/inbox.mock";
import { Card, CardTitle } from "@/components/ui/bits";
import { BtnLink } from "@/components/ui/Btn";
import { Pill, Tag } from "@/components/ui/Pill";
import { DemoNote } from "@/components/ui/DemoNote";

/** Patient-scoped view over the shared Inbox threads. */
export function PatientMessagesTab({ patientId }: { patientId: string }) {
  const threads = useInboxThreads().filter((t) => t.patientId === patientId);
  return (
    <div data-screen-label="Patient Messages" className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-[10px]">
          <CardTitle className="flex-1">Conversations</CardTitle>
          <BtnLink size="sm" href="/inbox" variant="primary">Open Inbox workspace</BtnLink>
        </div>
        {threads.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-[12.5px] text-faint">No conversations yet.</p>
        ) : (
          threads.map((t) => {
            const last = t.messages.filter((m) => !m.internal).at(-1);
            return (
              <Link
                key={t.id}
                href={`/inbox?thread=${t.id}`}
                className="flex items-start gap-3 border-b border-hairline px-4 py-[10px] last:border-b-0 hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-[7px]">
                    <span className="truncate text-[13px] font-semibold text-ink">{t.subject}</span>
                    {t.unread && <Pill tone="teal">Unread</Pill>}
                    {t.priority && <Pill tone={t.priority === "High" ? "critical" : "slate"}>{t.priority}</Pill>}
                    <Tag className="ml-auto">{t.channel}</Tag>
                  </span>
                  {last && (
                    <span className="mt-[2px] block truncate text-[12px] text-body">
                      {last.author === "practitioner" ? "You: " : ""}
                      {last.body}
                    </span>
                  )}
                  <span className="mt-[2px] block text-[11px] text-faint">{t.atLabel} · {t.status}</span>
                </span>
              </Link>
            );
          })
        )}
      </Card>
      <DemoNote>
        Secure portal messages only — replies compose in the Inbox with review-gated sending.
        Nothing sends outside the demo session.
      </DemoNote>
    </div>
  );
}
