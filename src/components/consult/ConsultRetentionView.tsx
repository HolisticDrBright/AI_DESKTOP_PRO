"use client";

import { PURGE_REFUSAL_LABEL, type ConsultPurgeRefusal } from "@/contracts/consultRetention";

/**
 * Erasing the contact details of an enquirer who never became a patient.
 *
 * Rendered from props so each state is testable. Four things it must get right.
 *
 * It says there is no retention window rather than showing a blank field that reads as one. A
 * practice that believed enquiries expired on their own would be keeping them forever.
 *
 * It says what a purge removes and what it keeps. "Erase" that silently kept the row would be a
 * lie, and "erase" that silently deleted the clinic's record of having been asked would be a
 * different one.
 *
 * It shows the reason a purge was refused, because "you have not answered this one yet" is
 * something the practitioner can act on and a failed button is not.
 *
 * It says plainly that a converted enquirer is covered by their own erasure instead, so nobody
 * concludes that path is missing.
 */
export type ConsultRetentionState = {
  window: number | null;
  counts: { purgeable: number; stillHeld: number; alreadyPurged: number } | null;
  draftDays: string;
  lastRefusal: ConsultPurgeRefusal | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onDraftDays: (value: string) => void;
  onSetWindow: (days: number | null) => void;
  onSweep: () => void;
};

export function ConsultRetentionView({ state }: { state: ConsultRetentionState }) {
  const { window: retention, counts, draftDays, lastRefusal, busy, error, notice } = state;
  const days = Number(draftDays);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 3650;
  const field = "block w-full rounded border p-2 text-sm";
  return (
    <div data-testid="consult-retention" className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">How long enquiries are kept</h3>
      <p className="mt-1 text-sm">
        Someone who asks about care and never becomes a patient has no account here, so they cannot ask you to
        erase anything. Erasing their contact details is yours to do. It removes the sealed contact envelope and
        keeps the rest of the row — which link, what kind of visit, when it arrived, what you decided — so your
        record of having been asked and having answered survives, and identifies nobody.
      </p>
      <p data-testid="consult-retention-converted-note" className="mt-1 text-sm">
        Anyone who did become a patient is not erased here. Their own erasure request reaches their enquiry along
        with the rest of their record.
      </p>
      {error && <p role="alert" data-testid="consult-retention-error" className="mt-2 text-sm text-critical">{error}</p>}
      {notice && <p role="status" data-testid="consult-retention-notice" className="mt-2 text-sm">{notice}</p>}
      {lastRefusal && (
        <p role="status" data-testid={`consult-retention-refusal-${lastRefusal}`} className="mt-2 text-sm">
          Nothing was erased. {PURGE_REFUSAL_LABEL[lastRefusal]}
        </p>
      )}

      {retention === null ? (
        <p data-testid="consult-retention-none" className="mt-2 text-sm font-semibold">
          You have not set a retention window, so nothing is ever erased automatically. Enquiries keep their
          contact details until you erase them yourself. That is a choice, not a default — set a window below if
          you want them to go on their own.
        </p>
      ) : (
        <p data-testid="consult-retention-window" className="mt-2 text-sm font-semibold">
          Unanswered enquiries become erasable {retention} days after they arrive, and a sweep erases them.
        </p>
      )}

      {counts && (
        <p data-testid="consult-retention-counts" className="mt-2 text-sm">
          {counts.stillHeld} enquir{counts.stillHeld === 1 ? "y" : "ies"} still hold contact details,
          {" "}{counts.purgeable} can be erased now, {counts.alreadyPurged} already have been.
        </p>
      )}

      <label className="mt-2 block text-sm">Erase unanswered enquiries this many days after they arrive
        <input className={field} data-testid="consult-retention-days" inputMode="numeric" value={draftDays}
          disabled={busy} onChange={event => state.onDraftDays(event.target.value)} />
      </label>
      {draftDays.length > 0 && !daysValid && (
        <p role="alert" data-testid="consult-retention-days-invalid" className="text-sm text-critical">
          A whole number of days from 1 to 3650.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" data-testid="consult-retention-save" disabled={busy || !daysValid}
          onClick={() => state.onSetWindow(days)}
          className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
          {busy ? "Saving…" : "Set this window"}
        </button>
        <button type="button" data-testid="consult-retention-clear" disabled={busy || retention === null}
          onClick={() => state.onSetWindow(null)}
          className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">
          Keep enquiries until I erase them
        </button>
        <button type="button" data-testid="consult-retention-sweep" disabled={busy || retention === null}
          onClick={state.onSweep}
          className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">
          {retention === null ? "Nothing to sweep without a window" : "Erase everything past the window"}
        </button>
      </div>
    </div>
  );
}
