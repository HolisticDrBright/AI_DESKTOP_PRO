"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/bits";
import { allFunnels, CHANNEL_LABEL, type FunnelDefinition } from "@/funnels";
import { consultLinkUrl } from "@/lib/consultLinkUrl";
import { funnelPageUrl, publicSiteOrigin } from "@/lib/publicSite";
import { COUNT_WINDOWS, formatWindowCount, funnelRequestCounts, QUEUE_READ_LIMIT, type QueueRead, type QueueRow } from "./funnelRequestCounts";

/**
 * The staff Funnels screen, read-only. Each funnel's status, its public address to copy, a preview
 * link, and the state of the consult link it hands off to, read from the existing link list. A
 * published funnel pointing at a missing, disabled or paused link is called out. A failure to
 * read the link list is shown as a failure, never as "no links": with the backend down nobody is
 * in a position to say which links exist.
 *
 * Each funnel also shows requests per channel (web, and email once its link exists) for the last 7 and 30
 * days, counted from the queue by the slug each request already carries: counts only, never a name. A
 * queue that cannot be read says so instead of showing zero.
 */
export type ConsultLinkState = {
  linkId: string; slug: string; label: string; status: "active" | "disabled"; acceptingRequests: boolean; openRequests: number;
};
export type LinkRead = { state: "loading" } | { state: "failed" } | { state: "read"; links: ConsultLinkState[] };

async function readQueue(): Promise<QueueRow[]> {
  const response = await fetch("/api/live/consult-requests", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "queue", request: { action: "list", limit: QUEUE_READ_LIMIT } }),
  });
  if (!response.ok) throw new Error("consult_queue_unavailable");
  const body = await response.json() as { data?: { requests?: Array<{ slug?: unknown; receivedAt?: unknown }> } };
  if (!Array.isArray(body.data?.requests)) throw new Error("consult_queue_unavailable");
  // Only the two fields a count needs leave this function; nothing else of a request is kept on this screen.
  return body.data.requests.map(row => {
    if (typeof row.slug !== "string" || typeof row.receivedAt !== "string" || Number.isNaN(Date.parse(row.receivedAt))) throw new Error("consult_queue_unavailable");
    return { slug: row.slug, receivedAt: row.receivedAt };
  });
}

async function readLinks(): Promise<ConsultLinkState[]> {
  const response = await fetch("/api/live/consult-requests", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "links", request: { action: "list" } }),
  });
  if (!response.ok) throw new Error("consult_links_unavailable");
  const body = await response.json() as { data?: { links?: ConsultLinkState[] } };
  if (!Array.isArray(body.data?.links)) throw new Error("consult_links_unavailable");
  return body.data.links;
}

/** `updatesOrigin`: the campaign sign-up origin as the server read it (it is not a public build value), or null. */
export function FunnelsScreen({ updatesOrigin = null }: { updatesOrigin?: string | null }) {
  const [read, setRead] = useState<LinkRead>({ state: "loading" });
  const [queue, setQueue] = useState<QueueRead>({ state: "loading" });
  const [now, setNow] = useState(() => new Date());
  const load = useCallback(async () => {
    setRead({ state: "loading" }); setQueue({ state: "loading" }); setNow(new Date());
    // Read separately: one failing says nothing about the other.
    await Promise.all([
      readLinks().then(links => setRead({ state: "read", links }), () => setRead({ state: "failed" })),
      readQueue().then(requests => setQueue({ state: "read", requests }), () => setQueue({ state: "failed" })),
    ]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Read as a literal so the bundler inlines the public value for the browser.
  const origin = publicSiteOrigin({ NEXT_PUBLIC_SITE_ORIGIN: process.env.NEXT_PUBLIC_SITE_ORIGIN });
  return <FunnelsView funnels={allFunnels()} read={read} queue={queue} origin={origin} updatesOrigin={updatesOrigin} now={now} onRetry={() => void load()} />;
}

/** What a funnel's hand-off looks like against the link list that was actually read. */
export function describeHandoff(funnel: FunnelDefinition, read: LinkRead): { tone: "ok" | "warning" | "unknown"; text: string } {
  if (read.state === "loading") return { tone: "unknown", text: "Reading the consult link list…" };
  if (read.state === "failed") return { tone: "unknown", text: "The consult link list could not be read, so the state of this funnel's link is unknown. This is not the same as having no link." };
  const link = read.links.find(candidate => candidate.slug === funnel.consultSlug);
  if (!link) return { tone: funnel.status === "published" ? "warning" : "unknown", text: `No consult link with slug "${funnel.consultSlug}" exists. ${funnel.status === "published" ? "Visitors who follow this published page reach nothing." : "Create it before publishing."}` };
  if (link.status === "disabled") return { tone: funnel.status === "published" ? "warning" : "unknown", text: `The consult link "${link.label}" is disabled.${funnel.status === "published" ? " A published funnel points at it." : ""}` };
  if (!link.acceptingRequests) return { tone: funnel.status === "published" ? "warning" : "unknown", text: `The consult link "${link.label}" is paused and not accepting requests.${funnel.status === "published" ? " A published funnel points at it." : ""}` };
  return { tone: "ok", text: `Hands off to "${link.label}", active and accepting requests; ${link.openRequests} waiting.` };
}

/** The same reading for a funnel's email link: campaign emails send visitors to the page with `?via=email`, whose button points here. */
export function describeChannelLink(funnel: FunnelDefinition, slug: string, read: LinkRead): { tone: "ok" | "warning" | "unknown"; text: string } {
  if (read.state === "loading") return { tone: "unknown", text: "Reading the consult link list…" };
  if (read.state === "failed") return { tone: "unknown", text: "The consult link list could not be read, so the state of this link is unknown." };
  const link = read.links.find(candidate => candidate.slug === slug);
  const live = funnel.status === "published";
  if (!link) return { tone: live ? "warning" : "unknown", text: `No consult link with slug "${slug}" exists. Create it through the link administration before campaign emails point at this page.` };
  if (link.status === "disabled") return { tone: live ? "warning" : "unknown", text: `"${link.label}" is disabled.` };
  if (!link.acceptingRequests) return { tone: live ? "warning" : "unknown", text: `"${link.label}" is paused and not accepting requests.` };
  return { tone: "ok", text: `"${link.label}", active and accepting requests; ${link.openRequests} waiting.` };
}

function RequestCounts({ funnel, queue, now }: { funnel: FunnelDefinition; queue: QueueRead; now: Date }) {
  if (queue.state === "loading") return <p className="m-0 mt-2 text-[12.5px] text-subtle" data-testid={`funnel-counts-${funnel.slug}`} data-counts="loading">Reading requests…</p>;
  if (queue.state === "failed") {
    return <p className="m-0 mt-2 text-[12.5px] text-critical" data-testid={`funnel-counts-${funnel.slug}`} data-counts="failed">Requests could not be counted: the queue could not be read. This is not the same as no requests.</p>;
  }
  const counts = funnelRequestCounts(funnel, queue.requests, now);
  return (
    <table className="mt-2 text-[12.5px] text-body" data-testid={`funnel-counts-${funnel.slug}`} data-counts="read">
      <thead><tr><th className="pr-4 text-left font-semibold">Requests by channel</th>{COUNT_WINDOWS.map(days => <th key={days} className="pr-4 text-left font-semibold">Last {days} days</th>)}</tr></thead>
      <tbody>
        {counts.map(row => (
          <tr key={row.channel} data-testid={`funnel-count-${funnel.slug}-${row.channel}`}>
            <td className="pr-4">{CHANNEL_LABEL[row.channel]} <span className="text-subtle">({row.slug})</span></td>
            {COUNT_WINDOWS.map(days => <td key={days} className="pr-4">{formatWindowCount(row.windows[days])}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FunnelsView({ funnels, read, queue = { state: "loading" }, origin, updatesOrigin = null, now = new Date(), onRetry }: {
  funnels: readonly FunnelDefinition[]; read: LinkRead; queue?: QueueRead; origin: string | null; updatesOrigin?: string | null; now?: Date; onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="funnels-screen" data-links={read.state} data-queue={queue.state}>
      <p role="status" className="m-0 rounded-lg border border-line bg-card p-3 text-[13px] text-body" data-testid="funnels-purchase-status">
        Visitors may book a consultation or buy the program directly. The buy choice reads the offer written in the Program Studio through the program binding of the page; no page is bound to a program yet, prices have not been selected, and checkout, payment confirmation and automatic course access are not connected. An active consult link does not mean purchases work.
      </p>
      {origin === null && (
        <p role="status" data-testid="funnels-no-origin" className="m-0 text-[13px] text-subtle">
          No public web address is configured for this deployment, so these pages have no shareable address yet. Paths are shown instead of links.
        </p>
      )}
      {read.state === "failed" && (
        <p role="alert" data-testid="funnels-links-failed" className="m-0 text-[13px] text-critical">
          The consult link list could not be read. Nothing below says whether a link exists. <button type="button" className="underline" onClick={onRetry}>Read again</button>
        </p>
      )}
      {updatesOrigin === null && (
        <p role="status" data-testid="funnels-no-updates-origin" className="m-0 text-[13px] text-subtle">
          No campaign sign-up address is configured (CAMPAIGN_SIGNUP_ORIGIN), so no page shows &quot;Get updates about this program&quot;.
        </p>
      )}
      {queue.state === "failed" && (
        <p role="alert" data-testid="funnels-queue-failed" className="m-0 text-[13px] text-critical">
          The consult queue could not be read, so no request counts are shown. Nothing below says there were none. <button type="button" className="underline" onClick={onRetry}>Read again</button>
        </p>
      )}
      {funnels.map(funnel => {
        const handoff = describeHandoff(funnel, read);
        const emailSlug = funnel.channelConsultSlugs?.email ?? null;
        const emailLink = emailSlug ? describeChannelLink(funnel, emailSlug, read) : null;
        const pageUrl = funnelPageUrl(funnel.slug, origin === null ? {} : { NEXT_PUBLIC_SITE_ORIGIN: origin });
        const consultUrl = consultLinkUrl(funnel.consultSlug, origin ?? undefined);
        return (
          <div key={funnel.slug} data-testid={`funnel-${funnel.slug}`} data-status={funnel.status} data-handoff={handoff.tone}>
          <Card className="px-4 py-3">
            <CardTitle>{funnel.title}</CardTitle>
            <p className="m-0 text-[12.5px] text-subtle">{funnel.programLabel} · {funnel.status === "published" ? "Published" : "Draft: not public"}{funnel.indexable ? " · may be listed by search engines on the production origin" : ""}</p>
            {funnel.draftNote && <p className="m-0 mt-1 text-[12.5px] text-body">{funnel.draftNote}</p>}
            <p className="m-0 mt-2 text-[12.5px]"><a href={`/funnels/${funnel.slug}/preview`} className="text-action underline">Review draft page</a> · Private staff preview, not a published sales page</p>
            <p className="m-0 mt-2 break-all text-[12.5px] text-body">Public address: {pageUrl ?? `/learn/${funnel.slug} (no public address configured)`}</p>
            <p className="m-0 mt-1 break-all text-[12.5px] text-body">Consult link: {consultUrl ?? `/consult/${funnel.consultSlug} (no public address configured)`}</p>
            <p className="m-0 mt-1 text-[12.5px] text-body" data-testid={`funnel-binding-${funnel.slug}`}>{funnel.programBinding ? `Buy choice: bound to program ${funnel.programBinding.programId}; availability follows the published offer of that program.` : "Buy choice: not bound to a program, so direct purchase is unavailable on this page until Brandon names the program for sale."}</p>
            <p className={`m-0 mt-2 text-[12.5px] ${handoff.tone === "warning" ? "font-semibold text-critical" : "text-body"}`} data-testid={`funnel-handoff-${funnel.slug}`}>{handoff.text}</p>
            {emailLink && <p className={`m-0 mt-1 text-[12.5px] ${emailLink.tone === "warning" ? "font-semibold text-critical" : "text-body"}`} data-testid={`funnel-email-link-${funnel.slug}`} data-handoff={emailLink.tone}>Email link: {emailLink.text}</p>}
            <p className="m-0 mt-1 break-all text-[12.5px] text-body" data-testid={`funnel-updates-${funnel.slug}`}>{funnel.updates
              ? (updatesOrigin ? `Get updates: ${updatesOrigin}/signup/${funnel.updates.programKey}` : "Get updates: not shown on the page; the campaign sign-up address is not configured.")
              : "Get updates: this page has no campaign list."}</p>
            <RequestCounts funnel={funnel} queue={queue} now={now} />
            {funnel.status === "published"
              ? <p className="m-0 mt-2 text-[12.5px]"><a href={`/learn/${funnel.slug}`} target="_blank" rel="noreferrer" className="text-action underline">Open the public page</a></p>
              : <p className="m-0 mt-2 text-[12.5px] text-subtle">A draft has no public page; it answers not-found until it is published with approved text.</p>}
          </Card>
          </div>
        );
      })}
    </div>
  );
}
