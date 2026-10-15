"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConsultReviewResponse } from "@/contracts/consultRequests";
import { Card, CardTitle } from "@/components/ui/bits";
import { post, REASON_LABEL, requestSource, VISIT_LABEL } from "./ConsultRequestQueue";

/**
 * The leads board: the consult Requests queue's own rows, one column per state the queue records, with the program
 * page and channel each request came from and the queue's existing actions. Nothing new is recorded, and no request
 * is ever linked to a marketing list.
 *
 * The queue records five states: received, accepted, converted, declined and withdrawn. "Contacted" and
 * "scheduled" are not recorded anywhere, so the board does not invent them (see docs/claude-leads-board-2026-10-15.md
 * for the schema change they would need).
 */
type Request = Extract<ConsultReviewResponse, { action: "list" }>["requests"][number];
export const BOARD_COLUMNS = [
  { status: "received", title: "New" },
  { status: "accepted", title: "Accepted" },
  { status: "converted", title: "Chart created" },
  { status: "declined", title: "Declined" },
  { status: "withdrawn", title: "Withdrawn" },
] as const;
export const BOARD_READ_LIMIT = 200;

export type BoardState = { status: "loading" } | { status: "failed" } | { status: "read"; requests: Request[] };

export function ConsultRequestBoard() {
  const [state, setState] = useState<BoardState>({ status: "loading" });
  const [contact, setContact] = useState<{ requestId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const list = await post({ surface: "queue", request: { action: "list", limit: BOARD_READ_LIMIT } }) as Extract<ConsultReviewResponse, { action: "list" }>;
      setState({ status: "read", requests: list.requests });
    } catch { setState({ status: "failed" }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (body: unknown) => {
    setBusy(true); setProblem(null);
    try { await post(body); await load(); } catch { setProblem("That did not go through. Nothing was changed; the board shows the queue as it is now."); await load(); }
    finally { setBusy(false); }
  };
  const open = async (requestId: string) => {
    setBusy(true); setProblem(null);
    try {
      const c = await post({ surface: "contact", requestId }) as { contact: { name: string; email: string; phone: string | null } };
      setContact({ requestId, text: `${c.contact.name} · ${c.contact.email}${c.contact.phone ? ` · ${c.contact.phone}` : ""}` });
    } catch { setProblem("That request's contact details would not open. Do not guess at them."); }
    finally { setBusy(false); }
  };
  return <BoardView state={state} busy={busy} problem={problem} contact={contact} onAct={body => void act(body)} onOpen={id => void open(id)} onRetry={() => void load()} />;
}

const button = "rounded-md border border-hairline px-2 py-1 text-[12px] disabled:opacity-50";

export function BoardView({ state, busy, problem, contact, onAct, onOpen, onRetry }: {
  state: BoardState; busy: boolean; problem: string | null; contact: { requestId: string; text: string } | null;
  onAct: (body: unknown) => void; onOpen: (requestId: string) => void; onRetry: () => void;
}) {
  return (
    <Card data-testid="consult-board">
      <CardTitle>Leads board</CardTitle>
      {problem ? <p role="alert" className="mt-2 text-[13px] text-critical">{problem}</p> : null}
      {state.status === "loading" ? <p role="status" data-testid="consult-board-loading" className="text-[13px] text-faint">Loading requests.</p> : null}
      {state.status === "failed" ? <p role="alert" data-testid="consult-board-failed" className="text-[13px] text-critical">
        The consult queue could not be read, so the board is empty for that reason and no other. This is not the same as having no requests. <button type="button" className="underline" onClick={onRetry}>Read again</button></p> : null}
      {state.status === "read" ? <>
        {state.requests.length >= BOARD_READ_LIMIT ? <p className="text-[12px] text-faint" data-testid="consult-board-limit">Showing the newest {BOARD_READ_LIMIT} requests; older ones are not on the board.</p> : null}
        <div className="mt-2 grid grid-cols-5 gap-2" data-testid="consult-board-columns">
          {BOARD_COLUMNS.map(column => {
            const cards = state.requests.filter(r => r.status === column.status);
            return (
              <section key={column.status} data-testid={`consult-board-column-${column.status}`} className="min-w-0 rounded-md border border-hairline p-2">
                <h3 className="text-[12.5px] font-semibold">{column.title} <span className="text-faint">({cards.length})</span></h3>
                {cards.length === 0 ? <p className="mt-1 text-[12px] text-faint">None.</p> : null}
                {cards.map(r => (
                  <article key={r.requestId} data-testid="consult-board-card" className="mt-2 rounded border border-hairline p-2 text-[12px]">
                    <p className="font-semibold">{VISIT_LABEL[r.visitType] ?? r.visitType}</p>
                    <p className="text-faint">{REASON_LABEL[r.reasonCode] ?? r.reasonCode} · {r.reference}</p>
                    <p data-testid="consult-board-source">From {requestSource(r.slug)}</p>
                    <p className="text-faint">Received {new Date(r.receivedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</p>
                    {contact?.requestId === r.requestId ? <p data-testid="consult-board-contact">{contact.text}</p>
                      : r.status === "received" || r.status === "accepted" ? <button type="button" className={button} disabled={busy} onClick={() => onOpen(r.requestId)}>Show contact details</button> : null}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.status === "received" ? <>
                        <button type="button" className={button} disabled={busy} onClick={() => onAct({ surface: "queue", request: { action: "accept", requestId: r.requestId, expectedRevision: r.revision } })}>Accept</button>
                        <button type="button" className={button} disabled={busy} onClick={() => onAct({ surface: "queue", request: { action: "decline", requestId: r.requestId, expectedRevision: r.revision, declineReason: "outside_scope" } })}>Decline as outside scope</button>
                      </> : null}
                      {r.status === "accepted" ? <button type="button" className={button} disabled={busy} onClick={() => onAct({ surface: "queue", request: { action: "convert", requestId: r.requestId, expectedRevision: r.revision, syntheticRecordKey: `patient_syn_${r.reference.toLowerCase()}` } })}>Create chart and invitation</button> : null}
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] text-faint">&quot;Contacted&quot; and &quot;scheduled&quot; are not recorded by the queue, so they are not columns here.</p>
      </> : null}
    </Card>
  );
}
