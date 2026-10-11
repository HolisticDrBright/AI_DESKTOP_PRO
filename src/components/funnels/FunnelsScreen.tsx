"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/bits";
import { allFunnels, type FunnelDefinition } from "@/funnels";
import { consultLinkUrl } from "@/lib/consultLinkUrl";
import { funnelPageUrl, publicSiteOrigin } from "@/lib/publicSite";

/**
 * The staff Funnels screen, read-only. Each funnel's status, its public address to copy, a preview
 * link, and the state of the consult link it hands off to, read from the existing link list. A
 * published funnel pointing at a missing, disabled or paused link is called out. A failure to
 * read the link list is shown as a failure, never as "no links": with the backend down nobody is
 * in a position to say which links exist.
 */
export type ConsultLinkState = {
  linkId: string; slug: string; label: string; status: "active" | "disabled"; acceptingRequests: boolean; openRequests: number;
};
export type LinkRead = { state: "loading" } | { state: "failed" } | { state: "read"; links: ConsultLinkState[] };

async function readLinks(): Promise<ConsultLinkState[]> {
  const response = await fetch("/api/live/consult-requests", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "links", request: { action: "list" } }),
  });
  if (!response.ok) throw new Error("consult_links_unavailable");
  const body = await response.json() as { data?: { links?: ConsultLinkState[] } };
  if (!Array.isArray(body.data?.links)) throw new Error("consult_links_unavailable");
  return body.data.links;
}

export function FunnelsScreen() {
  const [read, setRead] = useState<LinkRead>({ state: "loading" });
  const load = useCallback(async () => {
    setRead({ state: "loading" });
    try { setRead({ state: "read", links: await readLinks() }); } catch { setRead({ state: "failed" }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Read as a literal so the bundler inlines the public value for the browser.
  const origin = publicSiteOrigin({ NEXT_PUBLIC_SITE_ORIGIN: process.env.NEXT_PUBLIC_SITE_ORIGIN });
  return <FunnelsView funnels={allFunnels()} read={read} origin={origin} onRetry={() => void load()} />;
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

export function FunnelsView({ funnels, read, origin, onRetry }: { funnels: readonly FunnelDefinition[]; read: LinkRead; origin: string | null; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-3" data-testid="funnels-screen" data-links={read.state}>
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
      {funnels.map(funnel => {
        const handoff = describeHandoff(funnel, read);
        const pageUrl = funnelPageUrl(funnel.slug, origin === null ? {} : { NEXT_PUBLIC_SITE_ORIGIN: origin });
        const consultUrl = consultLinkUrl(funnel.consultSlug, origin ?? undefined);
        return (
          <div key={funnel.slug} data-testid={`funnel-${funnel.slug}`} data-status={funnel.status} data-handoff={handoff.tone}>
          <Card className="px-4 py-3">
            <CardTitle>{funnel.title}</CardTitle>
            <p className="m-0 text-[12.5px] text-subtle">{funnel.programLabel} · {funnel.status === "published" ? "Published" : "Draft: not public"}{funnel.indexable ? " · may be listed by search engines on the production origin" : ""}</p>
            {funnel.draftNote && <p className="m-0 mt-1 text-[12.5px] text-body">{funnel.draftNote}</p>}
            <p className="m-0 mt-2 break-all text-[12.5px] text-body">Public address: {pageUrl ?? `/learn/${funnel.slug} (no public address configured)`}</p>
            <p className="m-0 mt-1 break-all text-[12.5px] text-body">Consult link: {consultUrl ?? `/consult/${funnel.consultSlug} (no public address configured)`}</p>
            <p className={`m-0 mt-2 text-[12.5px] ${handoff.tone === "warning" ? "font-semibold text-critical" : "text-body"}`} data-testid={`funnel-handoff-${funnel.slug}`}>{handoff.text}</p>
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
