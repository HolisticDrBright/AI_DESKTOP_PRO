"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { PURCHASE_HOLD_EXPLANATIONS, type CurriculumBinding, type ProgramOffer, type ProgramOfferResult } from "@/contracts/programOffers";
import { AUTHORING_HOLD_WORDS, describeOffer, EMPTY_OFFER_FORM, formFromOffer, holdWords, termsFromForm, type OfferForm } from "@/lib/programs/offerAuthoring";

/**
 * The program offer editor (program-offer/1) in the Studio: what this program is sold for, bound to
 * the exact published version, with every term explicit. A draft may be saved incomplete; it cannot
 * be bought. Publishing is held until the price, the approved processor mapping and the access terms
 * exist and the program has not been published again since the offer was bound. The state the
 * service answers is shown as what it is: "not connected" is not an empty list, and a failed read is
 * not "no offers".
 */
export type OfferRead =
  | { state: "loading" }
  | { state: "disabled"; reason: string }
  | { state: "failed"; message: string }
  | { state: "read"; offers: ProgramOffer[]; curriculum: CurriculumBinding | null };

const INPUT = "h-8 w-full rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold tracking-[0.02em] text-subtle uppercase";

function messageFor(error: unknown): string {
  if (error instanceof AdapterError) return AUTHORING_HOLD_WORDS[error.message] ?? error.message;
  return AUTHORING_HOLD_WORDS.service_unavailable!;
}

export function ProgramOfferEditor({ programId, session }: { programId: string; session: string }) {
  const [read, setRead] = useState<OfferRead>({ state: "loading" });
  const [form, setForm] = useState<OfferForm>(EMPTY_OFFER_FORM);
  const [editing, setEditing] = useState<{ offerId: string; revision: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retireReason, setRetireReason] = useState("");

  const load = useCallback(async () => {
    setRead({ state: "loading" });
    try {
      const result = await api.programs.offers({ action: "list", programId });
      if (result.action !== "list") throw new AdapterError("unknown");
      setRead({ state: "read", offers: result.offers, curriculum: result.curriculum });
    } catch (error) {
      if (error instanceof AdapterError && (error.message === "commerce_disabled" || error.message === "activation_refused")) setRead({ state: "disabled", reason: error.message });
      else setRead({ state: "failed", message: messageFor(error) });
    }
  }, [programId]);
  // A new Studio load (session) discards whatever was shown for the previous one.
  useEffect(() => { setEditing(null); setForm(EMPTY_OFFER_FORM); setProblems([]); setNotice(null); void load(); }, [load, session]);

  const run = async (work: () => Promise<ProgramOfferResult>, done: (result: ProgramOfferResult) => string) => {
    if (busy) return;
    setBusy(true); setProblems([]); setNotice(null);
    try {
      const result = await work();
      setNotice(done(result));
      setEditing(null); setForm(EMPTY_OFFER_FORM); setRetireReason("");
      await load();
    } catch (error) {
      const holds = error instanceof AdapterError && error.message === "publish_refused" ? (error as AdapterError & { holds?: string[] }).holds ?? [] : [];
      setProblems(holds.length ? holdWords(holds) : [messageFor(error)]);
    } finally { setBusy(false); }
  };
  const save = () => {
    const outcome = termsFromForm(form);
    if (!outcome.ok) { setProblems(outcome.problems); return; }
    void run(
      () => editing ? api.programs.offers({ action: "revise", offerId: editing.offerId, expectedRevision: editing.revision, terms: outcome.terms }) : api.programs.offers({ action: "create", programId, terms: outcome.terms }),
      result => result.action === "list" ? "Saved." : `Saved as a draft (revision ${result.offer.revision}). A draft cannot be bought.`,
    );
  };

  return (
    <ProgramOfferEditorView read={read} form={form} editing={editing !== null} problems={problems} notice={notice} busy={busy} retireReason={retireReason}
      onForm={setForm} onRetireReason={setRetireReason} onRetry={() => void load()} onSave={save}
      onEdit={offer => { setEditing({ offerId: offer.offerId, revision: offer.revision }); setForm(formFromOffer(offer)); setProblems([]); setNotice(null); }}
      onCancelEdit={() => { setEditing(null); setForm(EMPTY_OFFER_FORM); setProblems([]); }}
      onApprove={offer => void run(() => api.programs.offers({ action: "approve_provider_mapping", offerId: offer.offerId, expectedRevision: offer.revision }), () => "Processor price reference approved and recorded under your name.")}
      onPublish={offer => void run(() => api.programs.offers({ action: "publish", offerId: offer.offerId, expectedRevision: offer.revision }), () => "Published. Visitors may buy this program on these exact terms while the published version is unchanged.")}
      onRetire={offer => { if (retireReason.trim() === "") { setProblems(["Give a reason for retiring the offer."]); return; } void run(() => api.programs.offers({ action: "retire", offerId: offer.offerId, expectedRevision: offer.revision, reason: retireReason.trim() }), () => "Retired. Nobody can start a purchase against this offer."); }}
    />
  );
}

export function ProgramOfferEditorView(props: {
  read: OfferRead; form: OfferForm; editing: boolean; problems: string[]; notice: string | null; busy: boolean; retireReason: string;
  onForm: (form: OfferForm) => void; onRetireReason: (value: string) => void; onRetry: () => void; onSave: () => void;
  onEdit: (offer: ProgramOffer) => void; onCancelEdit: () => void; onApprove: (offer: ProgramOffer) => void; onPublish: (offer: ProgramOffer) => void; onRetire: (offer: ProgramOffer) => void;
}) {
  const { read, form, onForm } = props;
  const set = <K extends keyof OfferForm>(key: K) => (value: OfferForm[K]) => onForm({ ...form, [key]: value });
  return (
    <div data-testid="program-offer-editor" data-state={read.state}><Card className="px-4 py-3">
      <CardTitle className="mb-1">Program offer</CardTitle>
      <p className="m-0 mb-2 text-[12px] text-subtle">
        What this program is sold for, bound to the exact published version. Every term is explicit: no price, billing mode, duration or terms version is assumed. A draft can be saved incomplete and cannot be bought.
      </p>
      {read.state === "loading" && <p className="m-0 text-[12.5px] text-subtle" data-testid="offer-loading">Reading offers…</p>}
      {read.state === "disabled" && (
        <p role="status" className="m-0 text-[12.5px] text-body" data-testid="offer-disabled">{AUTHORING_HOLD_WORDS[read.reason] ?? AUTHORING_HOLD_WORDS.commerce_disabled}</p>
      )}
      {read.state === "failed" && (
        <p role="alert" className="m-0 text-[12.5px] text-critical" data-testid="offer-failed">
          The offers could not be read: {read.message} This is not the same as having no offer. <button type="button" className="underline" onClick={props.onRetry}>Read again</button>
        </p>
      )}
      {read.state === "read" && (
        <>
          <p className="m-0 text-[12px] text-subtle" data-testid="offer-curriculum">
            {read.curriculum ? `Published version ${read.curriculum.version} is what an offer binds to.` : "This program has no published patient-facing content; an offer cannot be written until it does."}
          </p>
          {read.offers.length === 0
            ? <p className="m-0 mt-2 text-[12.5px] text-faint" data-testid="offer-empty">No offers have been written for this program.</p>
            : (
              <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0" data-testid="offer-list">
                {read.offers.map(offer => <OfferRow key={offer.offerId} offer={offer} curriculum={read.curriculum} busy={props.busy} retireReason={props.retireReason} onRetireReason={props.onRetireReason} onEdit={props.onEdit} onApprove={props.onApprove} onPublish={props.onPublish} onRetire={props.onRetire} />)}
              </ul>
            )}
          {read.curriculum && (
            <form className="mt-3 border-t border-hairline-2 pt-3" data-testid="offer-form" onSubmit={event => { event.preventDefault(); props.onSave(); }}>
              <p className="m-0 mb-2 text-[12.5px] font-semibold text-body">{props.editing ? "Revise the draft" : "New offer"}</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <Field label="Mode" id="offer-mode">
                  <select id="offer-mode" className={INPUT} value={form.mode} data-testid="offer-mode" onChange={event => set("mode")(event.target.value as OfferForm["mode"])}>
                    <option value="paid">Paid</option>
                    <option value="complimentary">Complimentary (authorized, with a reason)</option>
                  </select>
                </Field>
                <Field label="Offer name" id="offer-name"><input id="offer-name" className={INPUT} value={form.name} data-testid="offer-name" onChange={event => set("name")(event.target.value)} /></Field>
                <Field label="Access duration (days, or empty while undecided)" id="offer-duration"><input id="offer-duration" className={INPUT} inputMode="numeric" value={form.accessDurationDays} data-testid="offer-duration" onChange={event => set("accessDurationDays")(event.target.value)} /></Field>
                {form.mode === "paid" ? (
                  <>
                    <Field label="Price (USD, exact, for example 19.99)" id="offer-amount"><input id="offer-amount" className={INPUT} inputMode="decimal" value={form.amount} data-testid="offer-amount" onChange={event => set("amount")(event.target.value)} /></Field>
                    <Field label="Billing" id="offer-billing">
                      <select id="offer-billing" className={INPUT} value={form.billing} data-testid="offer-billing" onChange={event => set("billing")(event.target.value as OfferForm["billing"])}>
                        <option value="">Choose…</option>
                        <option value="one_time">One payment</option>
                        <option value="monthly">Every month</option>
                        <option value="yearly">Every year</option>
                      </select>
                    </Field>
                    <Field label="Processor price reference (test mode)" id="offer-price-ref"><input id="offer-price-ref" className={INPUT} value={form.providerPriceRef} placeholder="price_…" data-testid="offer-price-ref" onChange={event => set("providerPriceRef")(event.target.value)} /></Field>
                  </>
                ) : (
                  <Field label="Reason for complimentary access (recorded under your name)" id="offer-reason"><input id="offer-reason" className={INPUT} value={form.reason} data-testid="offer-reason" onChange={event => set("reason")(event.target.value)} /></Field>
                )}
                <Field label="Access terms version (none written yet)" id="offer-terms"><input id="offer-terms" className={INPUT} value={form.accessTermsVersion} placeholder="education-access-terms/…" data-testid="offer-terms" onChange={event => set("accessTermsVersion")(event.target.value)} /></Field>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Btn type="submit" variant="primary" size="sm" disabled={props.busy} data-testid="offer-save">{props.editing ? "Save revision" : "Save draft"}</Btn>
                {props.editing && <Btn type="button" size="sm" onClick={props.onCancelEdit} data-testid="offer-cancel-edit">Cancel</Btn>}
                <span className="text-[11.5px] text-faint">Saving never publishes. Publishing is a separate step with its own holds.</span>
              </div>
            </form>
          )}
        </>
      )}
      {props.problems.length > 0 && (
        <ul role="alert" className="m-0 mt-2 list-disc pl-5 text-[12.5px] text-critical" data-testid="offer-problems">{props.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
      )}
      {props.notice && <p role="status" className="m-0 mt-2 text-[12.5px] text-body" data-testid="offer-notice">{props.notice}</p>}
    </Card></div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div><label className={LABEL} htmlFor={id}>{label}</label>{children}</div>;
}

function OfferRow({ offer, curriculum, busy, retireReason, onRetireReason, onEdit, onApprove, onPublish, onRetire }: {
  offer: ProgramOffer; curriculum: CurriculumBinding | null; busy: boolean; retireReason: string; onRetireReason: (value: string) => void;
  onEdit: (offer: ProgramOffer) => void; onApprove: (offer: ProgramOffer) => void; onPublish: (offer: ProgramOffer) => void; onRetire: (offer: ProgramOffer) => void;
}) {
  const summary = describeOffer(offer, curriculum);
  const unapproved = offer.mode === "paid" && offer.providerPrice !== null && offer.providerPrice.approval === null;
  return (
    <li className="rounded-lg border border-line p-2 text-[12.5px]" data-testid={`offer-${offer.offerId}`} data-state={offer.state} data-purchasable={summary.purchasable ? "true" : "false"}>
      <p className="m-0 font-semibold text-body">{summary.line}</p>
      {summary.holds.length > 0 && <ul className="m-0 mt-1 list-disc pl-5 text-subtle" data-testid="offer-holds">{summary.holds.map(hold => <li key={hold}>{hold}</li>)}</ul>}
      {offer.state === "published" && !summary.purchasable && offer.mode === "paid" && (
        <p className="m-0 mt-1 text-subtle" data-testid="offer-visitor-words">Visitors read: {PURCHASE_HOLD_EXPLANATIONS[summary.holds.length ? "curriculum_changed" : "offer_draft"]}</p>
      )}
      {offer.state === "published" && summary.purchasable && <p className="m-0 mt-1 text-subtle">Visitors may buy this program on these exact terms. Checkout itself is a separate boundary and may be unavailable.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {offer.state === "draft" && <Btn type="button" size="sm" disabled={busy} onClick={() => onEdit(offer)} data-testid="offer-edit">Revise</Btn>}
        {offer.state === "draft" && unapproved && <Btn type="button" size="sm" disabled={busy} onClick={() => onApprove(offer)} data-testid="offer-approve">Approve processor price reference</Btn>}
        {offer.state === "draft" && <Btn type="button" size="sm" variant="primary" disabled={busy} onClick={() => onPublish(offer)} data-testid="offer-publish">Publish</Btn>}
        {offer.state !== "retired" && (
          <>
            <input className={`${INPUT} !w-[220px]`} value={retireReason} placeholder="Reason for retiring" aria-label="Reason for retiring" data-testid="offer-retire-reason" onChange={event => onRetireReason(event.target.value)} />
            <Btn type="button" size="sm" variant="danger" disabled={busy} onClick={() => onRetire(offer)} data-testid="offer-retire">Retire</Btn>
          </>
        )}
      </div>
    </li>
  );
}
