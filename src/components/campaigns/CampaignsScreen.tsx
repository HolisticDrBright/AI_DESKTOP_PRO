"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/bits";
import { LEAD_PROGRAM_LABEL, campaignCounts, type CampaignCounts } from "@/contracts/leadCampaigns";

/**
 * The staff Campaigns screen, read-only. Whether the campaign service is configured, each program
 * list's confirmed subscriber count, and recent sends with their totals, plus a link to the campaign
 * dashboard for editing. Counts only: no subscriber name or address ever reaches the Desktop. A
 * service that cannot be reached is shown as unreachable, never as empty lists; a total the service
 * does not report is Unknown, never zero. Whether the service may send at all is shown with the names
 * of any missing sending settings (never their values).
 */
export type CampaignsRead =
  | { state: "loading" } | { state: "failed" } | { state: "not_configured" }
  | { state: "ok"; counts: CampaignCounts; dashboardUrl: string | null };

async function readCampaigns(): Promise<CampaignsRead> {
  const response = await fetch("/api/live/campaigns", { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) return { state: "failed" };
  const body = await response.json() as { data?: { state?: string; counts?: unknown; dashboardUrl?: unknown } };
  if (body.data?.state === "not_configured") return { state: "not_configured" };
  const counts = campaignCounts.safeParse(body.data?.counts);
  if (body.data?.state !== "ok" || !counts.success) return { state: "failed" };
  return { state: "ok", counts: counts.data, dashboardUrl: typeof body.data.dashboardUrl === "string" ? body.data.dashboardUrl : null };
}

export function CampaignsScreen() {
  const [read, setRead] = useState<CampaignsRead>({ state: "loading" });
  const load = useCallback(async () => {
    setRead({ state: "loading" });
    try { setRead(await readCampaigns()); } catch { setRead({ state: "failed" }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <CampaignsView read={read} onRetry={() => void load()} />;
}

const known = (value: number | null) => value === null ? "Unknown" : String(value);
export function CampaignsView({ read, onRetry }: { read: CampaignsRead; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-3" data-testid="campaigns-screen" data-state={read.state}>
      <p role="status" className="m-0 rounded-lg border border-line bg-card p-3 text-[13px] text-body">
        Email updates for people who asked to hear about a program and confirmed their address. These are leads, not patients: nothing from a chart, the consult queue or the patient app is ever sent to the campaign service, and it never learns who became a patient.
      </p>
      {read.state === "loading" && <p role="status" className="m-0 text-[13px] text-subtle">Reading the campaign service…</p>}
      {read.state === "not_configured" && (
        <p role="status" data-testid="campaigns-not-configured" className="m-0 text-[13px] text-body">
          No campaign service is configured for this deployment. Nothing is being collected or sent.
        </p>
      )}
      {read.state === "failed" && (
        <p role="alert" data-testid="campaigns-failed" className="m-0 text-[13px] text-critical">
          The campaign service could not be reached. Nothing below says how many people are on a list or whether anything was sent. <button type="button" className="underline" onClick={onRetry}>Read again</button>
        </p>
      )}
      {read.state === "ok" && (
        <>
          <p role="status" data-testid="campaigns-sending" data-ready={String(read.counts.sending.ready)} className={`m-0 text-[13px] ${read.counts.sending.ready ? "text-body" : "font-semibold text-critical"}`}>
            {read.counts.sending.ready
              ? "Every sending setting is set. What is sent is still decided in the campaign dashboard, and only approved text may be scheduled."
              : `Sending is off. The campaign service sends nothing, not even a confirmation email, until these settings are set: ${read.counts.sending.missing.join(", ")}.`}
          </p>
          <Card className="px-4 py-3">
            <CardTitle>Program lists</CardTitle>
            {read.counts.lists.every(list => list.confirmed === 0) && <p data-testid="campaigns-no-subscribers" className="m-0 mt-2 text-[13px] text-subtle">No one has confirmed a subscription yet.</p>}
            <ul className="m-0 mt-2 list-none p-0 text-[13px] text-body">
              {read.counts.lists.map(list => (
                <li key={list.program} data-testid={`campaign-list-${list.program}`}>{LEAD_PROGRAM_LABEL[list.program]}: {list.confirmed} confirmed {list.confirmed === 1 ? "subscriber" : "subscribers"}</li>
              ))}
            </ul>
          </Card>
          <Card className="px-4 py-3">
            <CardTitle>Recent sends</CardTitle>
            {read.counts.recentSends.length === 0
              ? <p data-testid="campaigns-no-sends" className="m-0 mt-2 text-[13px] text-subtle">The campaign service reports no sends yet.</p>
              : (
                <ul className="m-0 mt-2 list-none p-0 text-[13px] text-body">
                  {read.counts.recentSends.map((send, i) => (
                    <li key={`${send.name}-${i}`} data-testid="campaign-send">{send.name} · {send.sentAt ? new Date(send.sentAt).toLocaleString() : "Send time Unknown"} · {send.delivered} delivered · {send.bounced} bounced · {known(send.unsubscribed)} unsubscribed</li>
                  ))}
                </ul>
              )}
          </Card>
          {read.dashboardUrl
            ? <p className="m-0 text-[13px]"><a href={read.dashboardUrl} target="_blank" rel="noreferrer" className="text-action underline">Open the campaign dashboard to edit</a></p>
            : <p className="m-0 text-[13px] text-subtle">No campaign dashboard address is configured.</p>}
        </>
      )}
    </div>
  );
}
