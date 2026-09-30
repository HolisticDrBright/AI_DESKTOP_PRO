"use client";

import { CART_EXCLUSION_LABEL, type CartLine, type ProtocolCartResponse } from "@/contracts/protocolCarts";

/**
 * The cart a published protocol compiles to.
 *
 * Rendered from props so each state is testable. Four things it must get right.
 *
 * It shows the excluded lines. A screen that listed only what could be bought would hide the
 * two products the practitioner most needs to think about, and would look complete while doing
 * it.
 *
 * It says why each one is out, in words, and says the decision is the practitioner's. "Contains
 * iron" with no reason reads as a bug rather than a rule.
 *
 * It never implies anything was sent. Nothing is delivered anywhere yet, and a screen with a
 * "sent to dispensary" tone would be a lie the clinic would find out about from a patient.
 *
 * It says the cart came from a published version, and shows which. A cart is compiled once per
 * version, so a practitioner looking at a superseded one has to be able to tell.
 */
type Manifest = Extract<ProtocolCartResponse, { action: "read" }>;

export type ProtocolCartState = {
  manifest: Manifest | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onCompile: () => void;
};

const line = (entry: CartLine, index: number) => (
  <li key={`${entry.itemId}-${index}`} data-testid={entry.included ? "cart-line-included" : "cart-line-excluded"}
    className="border-t border-hairline py-2">
    <span className="font-semibold">{entry.title}</span> · {entry.dose}
    {entry.included
      ? null
      : (
        <p data-testid={`cart-exclusion-${entry.exclusionReason}`} className="mt-1 text-sm">
          Not in the cart. {entry.exclusionReason ? CART_EXCLUSION_LABEL[entry.exclusionReason] : ""}
        </p>
      )}
  </li>
);

export function ProtocolCartView({ state }: { state: ProtocolCartState }) {
  const { manifest, busy, error, notice } = state;
  return (
    <div data-testid="protocol-cart" className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Supplements in this protocol</h3>
      <p className="mt-1 text-sm">
        This builds the list from the published version itself, and applies the exclusions while it builds it.
        Nothing is ordered and no cart is created anywhere — this is the list a purchase step would read.
      </p>
      {error && <p role="alert" data-testid="protocol-cart-error" className="mt-2 text-sm text-critical">{error}</p>}
      {notice && <p role="status" data-testid="protocol-cart-notice" className="mt-2 text-sm">{notice}</p>}

      <button type="button" data-testid="protocol-cart-compile" disabled={busy} onClick={state.onCompile}
        className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
        {busy ? "Building…" : "Build the supplement list"}
      </button>

      {manifest && (
        <>
          <p data-testid="protocol-cart-source" className="mt-2 text-sm font-semibold">
            From published version {manifest.programVersion}
            {manifest.status === "superseded" ? " — a newer version has since been published" : ""}.
            {" "}{manifest.includedCount} to buy, {manifest.excludedCount} for you to decide.
          </p>
          <ul className="mt-1 list-none p-0 text-sm">{manifest.lines.map(line)}</ul>
          {manifest.excludedCount > 0 && (
            <p data-testid="protocol-cart-excluded-note" className="mt-2 text-sm">
              The excluded ones are not refused, they are yours. Iron depends on a ferritin this list cannot see, and
              anything touching pregnancy, nursing or fertility is an individual decision.
            </p>
          )}
          <p data-testid="protocol-cart-delivery" className="mt-2 text-sm">
            Nothing has been sent. There is no ordering step yet, so nobody has been charged and no dispensary has
            been contacted.
          </p>
        </>
      )}
    </div>
  );
}
