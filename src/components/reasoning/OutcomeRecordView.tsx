"use client";

import { AGE_BAND_LABEL, OUTCOME_LABEL, outcomeCode, outcomeFollowupBand, outcomeSex,
  type OutcomeAgeBand, type OutcomeLedgerResponse } from "@/contracts/practiceOutcomes";

/**
 * Recording what happened, for counting later.
 *
 * Rendered from props so each state is testable. Three things it must get right.
 *
 * It says what is kept and what is not, before anything is sent. A practitioner recording an
 * outcome is recording something about a person, and "age in years, banded to five" is a
 * different promise from "age".
 *
 * It says this needs its own consent and cannot borrow the treatment consent, and when that
 * consent is absent it says so instead of failing vaguely.
 *
 * It offers only declared codes. A free-text box here would put a sentence about a person into
 * the counted ledger, which is the one thing the whole design is arranged to prevent.
 */
type Vocabulary = Extract<OutcomeLedgerResponse, { action: "vocabulary" }>["codes"];
type Recorded = Extract<OutcomeLedgerResponse, { action: "contribute" }>;

export type OutcomeRecordDraft = {
  ageYears: string;
  sex: (typeof outcomeSex)["options"][number];
  conditionCodes: string[];
  treatmentCode: string;
  outcomeCode: (typeof outcomeCode)["options"][number];
  followupBand: (typeof outcomeFollowupBand)["options"][number];
};
export type OutcomeRecordState = {
  vocabulary: Vocabulary | null;
  draft: OutcomeRecordDraft;
  recorded: Recorded | null;
  consentAbsent: boolean;
  busy: boolean;
  error: string | null;
  onDraft: (patch: Partial<OutcomeRecordDraft>) => void;
  onRecord: () => void;
};

const FOLLOWUP_LABEL: Record<OutcomeRecordDraft["followupBand"], string> = {
  under_6_weeks: "Under 6 weeks later", "6_to_12_weeks": "6–12 weeks later",
  "3_to_6_months": "3–6 months later", "6_to_12_months": "6–12 months later",
  over_12_months: "Over a year later",
};

export function OutcomeRecordView({ state }: { state: OutcomeRecordState }) {
  const { vocabulary, draft, recorded, busy, error } = state;
  const conditions = (vocabulary ?? []).filter(entry => entry.kind === "condition" && entry.status === "active");
  const treatments = (vocabulary ?? []).filter(entry => entry.kind === "treatment" && entry.status === "active");
  const age = Number(draft.ageYears);
  const ageValid = Number.isInteger(age) && age >= 18 && age <= 130;
  const ready = ageValid && draft.conditionCodes.length > 0 && draft.treatmentCode.length > 0;
  const field = "block w-full rounded border p-2 text-sm";
  return (
    <div data-testid="outcome-record" className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Record what happened</h3>
      <p className="mt-1 text-sm">
        This is counted, never quoted. No name, no note, no date and no exact age are kept — the age you type is
        banded to five years before it is stored, and everyone over 89 is stored as one band.
      </p>
      <p data-testid="outcome-record-consent-note" className="mt-1 text-sm">
        It needs its own consent to be counted, separate from consent to be treated. Agreeing to care is not
        agreeing to this, and it can be taken back at any time — which deletes what was contributed.
      </p>
      {error && <p role="alert" data-testid="outcome-record-error" className="mt-2 text-sm text-critical">{error}</p>}
      {state.consentAbsent && (
        <p role="alert" data-testid="outcome-record-consent-absent" className="mt-2 text-sm text-critical">
          This person has not agreed to be counted, so nothing was recorded. Ask them, record the consent, and
          come back.
        </p>
      )}
      {recorded && (
        <p role="status" data-testid="outcome-record-done" className="mt-2 text-sm">
          Recorded in the {AGE_BAND_LABEL(recorded.ageBand as OutcomeAgeBand)} band. The exact age was not kept.
        </p>
      )}

      {vocabulary !== null && conditions.length === 0 ? (
        <p data-testid="outcome-record-no-codes" className="mt-2 text-sm">
          Nothing can be recorded yet: this practice has not declared the conditions and treatments it counts by.
          That list is deliberate — it is what stops a description of a person being stored as a code.
        </p>
      ) : (
        <>
          <label className="mt-2 block text-sm">Age in years
            <input className={field} data-testid="outcome-record-age" inputMode="numeric" value={draft.ageYears}
              disabled={busy} onChange={event => state.onDraft({ ageYears: event.target.value })} />
          </label>
          {draft.ageYears.length > 0 && !ageValid && (
            <p role="alert" data-testid="outcome-record-age-invalid" className="text-sm text-critical">
              A whole number from 18 to 130. This product is 18+, so a younger age is not recordable here.
            </p>
          )}

          <label className="mt-2 block text-sm">Sex
            <select className={field} data-testid="outcome-record-sex" value={draft.sex} disabled={busy}
              onChange={event => state.onDraft({ sex: event.target.value as OutcomeRecordDraft["sex"] })}>
              {outcomeSex.options.map(value => <option key={value} value={value}>{value.replace("_", " ")}</option>)}
            </select>
          </label>

          <fieldset className="mt-2">
            <legend className="text-sm">What was being treated (up to five)</legend>
            {conditions.map(entry => {
              const chosen = draft.conditionCodes.includes(entry.code);
              return (
                <label key={entry.code} className="mr-3 text-sm">
                  <input type="checkbox" data-testid={`outcome-record-condition-${entry.code}`} checked={chosen}
                    disabled={busy || (!chosen && draft.conditionCodes.length >= 5)}
                    onChange={() => state.onDraft({ conditionCodes: chosen
                      ? draft.conditionCodes.filter(code => code !== entry.code)
                      : [...draft.conditionCodes, entry.code] })} />
                  {" "}{entry.label}
                </label>
              );
            })}
          </fieldset>

          <label className="mt-2 block text-sm">What you did
            <select className={field} data-testid="outcome-record-treatment" value={draft.treatmentCode} disabled={busy}
              onChange={event => state.onDraft({ treatmentCode: event.target.value })}>
              <option value="">Choose one</option>
              {treatments.map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
            </select>
          </label>

          <label className="mt-2 block text-sm">What happened
            <select className={field} data-testid="outcome-record-outcome" value={draft.outcomeCode} disabled={busy}
              onChange={event => state.onDraft({ outcomeCode: event.target.value as OutcomeRecordDraft["outcomeCode"] })}>
              {outcomeCode.options.map(value => <option key={value} value={value}>{OUTCOME_LABEL[value]}</option>)}
            </select>
          </label>

          <label className="mt-2 block text-sm">How long after
            <select className={field} data-testid="outcome-record-followup" value={draft.followupBand} disabled={busy}
              onChange={event => state.onDraft({ followupBand: event.target.value as OutcomeRecordDraft["followupBand"] })}>
              {outcomeFollowupBand.options.map(value => (
                <option key={value} value={value}>{FOLLOWUP_LABEL[value]}</option>
              ))}
            </select>
          </label>

          <button type="button" data-testid="outcome-record-save" disabled={busy || !ready} onClick={state.onRecord}
            className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
            {busy ? "Recording…" : "Record this outcome"}
          </button>
        </>
      )}
    </div>
  );
}
