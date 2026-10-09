"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Inbox } from "lucide-react";

import type { ConsultLinkAdminResponse, ConsultReviewResponse } from "@/contracts/consultRequests";
import { Card, CardTitle } from "@/components/ui/bits";
import { Pill } from "@/components/ui/Pill";
import { consultLinkUrl } from "@/lib/consultLinkUrl";

/**
 * The clinic's consult link and the requests it has produced.
 *
 * Contact details are shown only when a practitioner asks for them, one request at a time,
 * because opening one is recorded on the clinical side and a screen that opened all of them
 * to draw a list would make that record meaningless.
 *
 * Converting a request creates a chart and a link that is still waiting for an invitation.
 * The panel says so, rather than implying the person is now a verified patient: nobody has
 * proved they are who the form said they were.
 */
type Links = Extract<ConsultLinkAdminResponse, { action: "list" }>;
type Queue = Extract<ConsultReviewResponse, { action: "list" }>;
type Contact = { requestId: string; reference: string; contact: { name: string; email: string; phone: string | null } };

const REASON_LABEL: Record<string, string> = {
  new_consultation: "Wants to become a patient", lab_review: "Lab review",
  follow_up_care: "Continuing care", supplement_question: "Supplement question",
  program_question: "Program question", insurance_question: "Payment question", other: "Other",
};
const VISIT_LABEL: Record<string, string> = {
  initial: "First consultation", follow_up: "Follow-up", urgent_question: "Urgent question",
};

async function post(body: unknown) {
  const response = await fetch("/api/live/consult-requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
  return payload.data;
}

export function ConsultRequestQueue() {
  const [links, setLinks] = useState<Links["links"] | null>(null);
  const [queue, setQueue] = useState<Queue["requests"] | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const [linkList, requestList] = await Promise.all([
        post({ surface: "links", request: { action: "list" } }) as Promise<Links>,
        post({ surface: "queue", request: { action: "list" } }) as Promise<Queue>,
      ]);
      setLinks(linkList.links);
      setQueue(requestList.requests);
    } catch (error) { setFailure(error instanceof Error ? error.message : "service_unavailable"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (body: unknown) => {
    setBusy(true); setFailure(null);
    try { await post(body); await load(); }
    catch (error) { setFailure(error instanceof Error ? error.message : "service_unavailable"); }
    finally { setBusy(false); }
  }, [load]);

  const open = useCallback(async (requestId: string) => {
    setBusy(true); setFailure(null);
    try { setContact(await post({ surface: "contact", requestId }) as Contact); }
    catch (error) { setFailure(error instanceof Error ? error.message : "service_unavailable"); }
    finally { setBusy(false); }
  }, []);

  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  const waiting = (queue ?? []).filter(request => request.status === "received" || request.status === "accepted");

  return (
    <Card data-testid="consult-request-queue">
      <CardTitle>
        <span className="inline-flex items-center gap-[6px]"><Inbox size={15} aria-hidden /> Consult requests</span>
      </CardTitle>
      {failure && (
        <p role="alert" data-testid="consult-queue-error" className="mt-2 text-[13px] text-critical">
          {failure === "consult_not_configured"
            ? "Contact details cannot be opened: the contact key is not configured for this deployment."
            : failure === "consult_contact_unreadable"
              ? "That request's contact details would not open. Do not guess at them; this needs a look."
              : "The consult queue could not be read."}
        </p>
      )}

      <h3 className="mt-3 text-[13px] font-semibold">Your links</h3>
      {links === null ? (
        <p role="status" className="text-[13px] text-faint">Loading your links.</p>
      ) : links.length === 0 ? (
        <p className="text-[13px] text-faint">
          No consult link yet. A link is how someone who is not a patient can reach you; without one, there is no way in.
        </p>
      ) : (
        <ul className="mt-1 list-none p-0">
          {links.map(link => {
            const url = consultLinkUrl(link.slug, origin);
            return (
              <li key={link.linkId} className="border-t border-hairline py-2 first:border-t-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold">{link.label}</span>
                  <Pill tone={link.status === "active" && link.acceptingRequests ? "positive" : "slate"}>
                    {link.status === "disabled" ? "Disabled" : link.acceptingRequests ? "Open" : "Paused"}
                  </Pill>
                </div>
                <p className="mt-1 break-all text-[12px] text-faint">
                  <Link2 size={12} className="mr-1 inline" aria-hidden />
                  {url ?? `/consult/${link.slug}`}
                </p>
                {!url && (
                  <p className="text-[12px] text-faint">
                    The shareable address is not configured for this deployment, so only the path is shown.
                  </p>
                )}
                <p className="text-[12px] text-faint">{link.openRequests} waiting</p>
                <button type="button" disabled={busy} onClick={() => void act({
                  surface: "links",
                  request: link.acceptingRequests
                    ? { action: "update", linkId: link.linkId, acceptingRequests: false }
                    : { action: "update", linkId: link.linkId, acceptingRequests: true },
                })} className="mt-1 rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50">
                  {link.acceptingRequests ? "Stop taking requests" : "Take requests again"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="mt-4 text-[13px] font-semibold">Waiting for you</h3>
      {queue === null ? (
        <p role="status" className="text-[13px] text-faint">Loading requests.</p>
      ) : waiting.length === 0 ? (
        <p className="text-[13px] text-faint">Nothing waiting.</p>
      ) : (
        <ul className="mt-1 list-none p-0">
          {waiting.map(request => (
            <li key={request.requestId} data-testid="consult-request-row" className="border-t border-hairline py-2 first:border-t-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">{VISIT_LABEL[request.visitType] ?? request.visitType}</span>
                <Pill tone={request.status === "received" ? "warning" : "positive"}>
                  {request.status === "received" ? "New" : "Accepted"}
                </Pill>
              </div>
              <p className="mt-1 text-[12px] text-faint">
                {REASON_LABEL[request.reasonCode] ?? request.reasonCode} · reference {request.reference}
                {request.timeZone ? ` · ${request.timeZone}` : ""}
              </p>
              {contact?.requestId === request.requestId ? (
                <p data-testid="consult-contact" className="mt-1 text-[12px]">
                  {contact.contact.name} · {contact.contact.email}
                  {contact.contact.phone ? ` · ${contact.contact.phone}` : ""}
                </p>
              ) : (
                <button type="button" disabled={busy} onClick={() => void open(request.requestId)}
                  className="mt-1 rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50">
                  Show contact details
                </button>
              )}
              <div className="mt-1 flex flex-wrap gap-2">
                {request.status === "received" && (
                  <>
                    <button type="button" disabled={busy} onClick={() => void act({
                      surface: "queue",
                      request: { action: "accept", requestId: request.requestId, expectedRevision: request.revision },
                    })} className="rounded-md bg-action px-2 py-1 text-[12px] font-semibold text-white disabled:opacity-50">
                      Accept
                    </button>
                    <button type="button" disabled={busy} onClick={() => void act({
                      surface: "queue",
                      request: {
                        action: "decline", requestId: request.requestId,
                        expectedRevision: request.revision, declineReason: "outside_scope",
                      },
                    })} className="rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50">
                      Decline as outside scope
                    </button>
                  </>
                )}
                {request.status === "accepted" && (
                  <button type="button" disabled={busy} onClick={() => void act({
                    surface: "queue",
                    request: {
                      action: "convert", requestId: request.requestId, expectedRevision: request.revision,
                      syntheticRecordKey: `patient_syn_${request.reference.toLowerCase()}`,
                    },
                  })} className="rounded-md bg-action px-2 py-1 text-[12px] font-semibold text-white disabled:opacity-50">
                    Create chart and invitation
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12px] text-faint">
        Creating a chart does not verify the person. The connection waits for an invitation they claim in the app,
        which is what links the chart to a real account.
      </p>
    </Card>
  );
}
