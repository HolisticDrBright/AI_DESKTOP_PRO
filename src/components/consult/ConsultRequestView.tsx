"use client";

import type { ConsultIntakeResponse } from "@/contracts/consultRequests";

/**
 * Everything the public consult page can say, as a function of what it knows.
 *
 * It is separated from the component that fetches so each state can be rendered and read
 * back in a test. The states this page can be in are the ones that matter most to get right —
 * "this link is gone", "we have your request", "we could not send it" — and a source scan
 * that merely finds the words in the file does not show which branch renders them.
 */
export const VISIT_LABEL: Record<string, string> = {
  initial: "First consultation",
  follow_up: "Follow-up visit",
  urgent_question: "Urgent question",
};
export const REASON_LABEL: Record<string, string> = {
  new_consultation: "I would like to become a patient",
  lab_review: "I would like lab results reviewed",
  follow_up_care: "I am continuing care I have started",
  supplement_question: "I have a question about supplements",
  program_question: "I have a question about a program",
  insurance_question: "I have a question about payment or insurance",
  other: "Something else",
};

export type Described = Extract<ConsultIntakeResponse, { action: "describe" }>;
export type Submitted = Extract<ConsultIntakeResponse, { action: "submit" }>;
export type ConsultFormValues = { name: string; email: string; phone: string; visitType: string; reasonCode: string };
export type ConsultViewState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "received"; result: Submitted }
  | {
    kind: "form"; link: Described; values: ConsultFormValues; busy: boolean; failure: string | null;
    onChange: (field: keyof ConsultFormValues, value: string) => void; onSubmit: () => void;
  };

const field = "mt-1 w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-[14px]";

export function ConsultRequestView({ state }: { state: ConsultViewState }) {
  if (state.kind === "loading") {
    return <p role="status" data-testid="consult-loading" className="text-[14px] text-faint">Loading this clinic&rsquo;s request form.</p>;
  }
  if (state.kind === "unavailable") {
    return (
      <section data-testid="consult-link-unavailable" className="rounded-lg border border-hairline bg-surface p-5">
        <h1 className="m-0 text-[19px] font-bold">This link is not available</h1>
        <p className="mt-2 text-[14px] text-faint">
          It may have been withdrawn or may have expired. Please contact the clinic directly for a current link.
        </p>
      </section>
    );
  }
  if (state.kind === "received") {
    const received = state.result.outcome === "received";
    return (
      <section data-testid="consult-request-received" className="rounded-lg border border-hairline bg-surface p-5">
        <h1 className="m-0 text-[19px] font-bold">
          {received ? "Your request has been sent" : "Please try again later"}
        </h1>
        {received && state.result.outcome === "received" ? (
          <>
            <p className="mt-2 text-[14px]">
              Keep this reference: <strong data-testid="consult-reference">{state.result.reference}</strong>
            </p>
            <p className="mt-2 text-[14px] text-faint">
              The clinic will reply to the address you gave. Nothing is booked yet: a request is not an appointment,
              and the clinic decides whether it can take you on.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[14px] text-faint">
            This link has taken a lot of requests recently, or you have already sent one today. Please try again later,
            or contact the clinic directly.
          </p>
        )}
      </section>
    );
  }

  const { link, values, busy, failure, onChange, onSubmit } = state;
  const ready = values.name.trim().length > 0 && /.+@.+\..+/.test(values.email.trim())
    && values.visitType.length > 0 && values.reasonCode.length > 0;
  return (
    <section data-testid="consult-request-form" className="rounded-lg border border-hairline bg-surface p-5">
      <h1 className="m-0 text-[19px] font-bold">{link.clinic}</h1>
      <p className="mt-1 text-[14px] text-faint">{link.label}</p>
      {!link.acceptingRequests && (
        <p role="status" data-testid="consult-not-accepting" className="mt-3 rounded-md bg-canvas p-3 text-[13px]">
          This clinic is not taking new requests through this link at the moment.
        </p>
      )}
      {/* Said on the page, not just enforced in the schema: someone with something urgent to
          say needs to be told where to say it, not left to type it in and wait. */}
      <p className="mt-3 rounded-md bg-canvas p-3 text-[13px]">
        Please do not describe symptoms or send health information here. This form only asks the clinic to get in
        touch. If you have an urgent medical problem, contact your doctor or your local emergency number.
      </p>

      <label className="mt-4 block text-[13px] font-semibold" htmlFor="consult-name">Your name</label>
      <input id="consult-name" value={values.name} onChange={event => onChange("name", event.target.value)}
        autoComplete="name" className={field} />

      <label className="mt-3 block text-[13px] font-semibold" htmlFor="consult-email">Email address</label>
      <input id="consult-email" value={values.email} onChange={event => onChange("email", event.target.value)}
        type="email" autoComplete="email" className={field} />

      <label className="mt-3 block text-[13px] font-semibold" htmlFor="consult-phone">Phone (optional)</label>
      <input id="consult-phone" value={values.phone} onChange={event => onChange("phone", event.target.value)}
        type="tel" autoComplete="tel" className={field} />

      <label className="mt-3 block text-[13px] font-semibold" htmlFor="consult-visit">Kind of visit</label>
      <select id="consult-visit" value={values.visitType} onChange={event => onChange("visitType", event.target.value)}
        className={field}>
        {link.visitTypes.map(type => <option key={type} value={type}>{VISIT_LABEL[type] ?? type}</option>)}
      </select>

      <label className="mt-3 block text-[13px] font-semibold" htmlFor="consult-reason">Reason</label>
      <select id="consult-reason" value={values.reasonCode} onChange={event => onChange("reasonCode", event.target.value)}
        className={field}>
        {link.reasonCodes.map(code => <option key={code} value={code}>{REASON_LABEL[code] ?? code}</option>)}
      </select>

      {failure && (
        <p role="alert" data-testid="consult-request-failed" className="mt-3 text-[13px] text-critical">
          {failure === "consult_not_configured"
            ? "This form is not ready to take requests yet. Please contact the clinic directly."
            : "That could not be sent. Please try again, or contact the clinic directly."}
        </p>
      )}

      <button type="button" data-testid="consult-submit" disabled={!ready || busy || !link.acceptingRequests}
        onClick={onSubmit}
        className="mt-4 w-full rounded-md bg-action px-3 py-2 text-[14px] font-semibold text-white disabled:opacity-50">
        {busy ? "Sending…" : "Send request"}
      </button>
      <p className="mt-2 text-[12px] text-faint">
        Sending this does not book an appointment and does not create a patient record.
      </p>
    </section>
  );
}
