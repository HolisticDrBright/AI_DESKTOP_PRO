"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type { LiveInboxTodaySummary } from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";

/**
 * Today's Inbox summary — counts of PERSISTED conversation and message rows
 * (open threads, unread inbound, urgent flags, due follow-ups, my assignments).
 * If the read fails, the card says so instead of showing zeros that could read
 * as "no messages waiting".
 */
export function TodayInboxLive() {
  const [summary, setSummary] = useState<LiveInboxTodaySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSummary(await api.inbox.todaySummary());
    } catch (e) {
      setError(e instanceof AdapterError ? e.message : "The inbox summary couldn't load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="px-4 py-[13px]" data-testid="today-inbox">
      <div className="flex items-center gap-2">
        <CardTitle className="mb-0">
          <Inbox size={13} strokeWidth={2} className="text-brand" aria-hidden />
          Inbox
        </CardTitle>
        <span className="flex-1" />
        <Link href="/inbox" className="text-[12px] font-semibold text-action hover:underline">
          Open inbox →
        </Link>
      </div>
      {error ? (
        <p className="m-0 mt-2 text-[12px] text-critical">{error}</p>
      ) : !summary ? (
        <p className="m-0 mt-2 text-[12px] text-faint">Loading…</p>
      ) : summary.openThreads === 0 && summary.unreadInbound === 0 ? (
        <p className="m-0 mt-2 text-[12px] text-faint" data-testid="today-inbox-summary">
          No open conversations in this organization.
        </p>
      ) : (
        <p className="m-0 mt-2 text-[12.5px] text-body" data-testid="today-inbox-summary">
          {summary.openThreads} open thread{summary.openThreads === 1 ? "" : "s"} ·{" "}
          {summary.unreadInbound} unread inbound
          {summary.urgentOpen > 0 ? (
            <>
              {" "}
              · <strong className="text-critical">{summary.urgentOpen} flagged urgent</strong>
            </>
          ) : null}
          {summary.dueFollowUps > 0 ? ` · ${summary.dueFollowUps} follow-ups due` : ""}
          {summary.myAssigned > 0 ? ` · ${summary.myAssigned} assigned to me` : ""}
        </p>
      )}
    </Card>
  );
}
