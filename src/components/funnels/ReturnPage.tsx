import type { OrderState } from '@/contracts/programCheckout';

/**
 * What a visitor reads when the processor sends them back. The address said "success" or
 * "cancel"; the page says what the order's state actually is, because the redirect proves nothing.
 * Payment is "confirmed" only for `payment_verified`; everything else is said as what it is, and an
 * order this site does not know is "unknown", never "failed". No account, email or claim is minted here.
 */
const SECTION = 'mx-auto w-full max-w-[760px] px-5 py-8 md:px-8';
const BUTTON = 'inline-flex h-11 items-center rounded-lg bg-action px-5 text-[15px] font-semibold text-white';

export const RETURN_WORDS: Record<OrderState | 'unknown', { heading: string; detail: string }> = {
  payment_verified: { heading: 'Your payment is confirmed', detail: 'The payment processor has confirmed this purchase. Your access is prepared next, and a one-time code to claim it is then emailed to the address you gave the payment processor. This page cannot tell whether that email has gone out; if it does not arrive, contact the clinic. Nothing on this page is your access. It is opened by the code, in your own account.' },
  checkout_open: { heading: 'Your payment is being confirmed', detail: 'We are waiting for the payment processor to confirm this purchase. This can take a few minutes. Arriving at this page is not confirmation; you can close it and return later.' },
  creation_unresolved: { heading: 'Your checkout could not be completed', detail: 'The checkout did not start cleanly. Nothing was charged on this site. You can start again from the program page.' },
  creation_pending: { heading: 'Your checkout is starting', detail: 'The checkout was recorded and is being opened with the payment processor. Nothing has been charged. You can start again from the program page; it will reopen this same checkout.' },
  creation_unreconciled: { heading: 'Your checkout could not be confirmed', detail: 'The payment processor did not confirm whether this checkout was opened. It has been held for review and cannot take a payment. You can request a consultation instead.' },
  payment_processing: { heading: 'Your payment is still processing', detail: 'The payment processor has the checkout and is still processing the payment, which can take several days for some payment methods. Nothing has been granted yet. You can close this page; arriving here is not confirmation.' },
  admitted: { heading: 'Your checkout did not start', detail: 'The checkout was recorded but never opened. Nothing was charged. You can start again from the program page.' },
  checkout_expired: { heading: 'The checkout expired', detail: 'The payment page was not completed in time and has closed. Nothing was charged. You can start again from the program page.' },
  checkout_cancelled: { heading: 'The checkout was cancelled', detail: 'Nothing was charged. You can start again from the program page whenever you like.' },
  payment_failed: { heading: 'The payment did not go through', detail: 'The payment processor reported that this payment was not completed. Nothing has been granted. You can try again from the program page or request a consultation instead.' },
  refused: { heading: 'The checkout was refused', detail: 'This checkout could not be used. Nothing was charged. You can start again from the program page or request a consultation.' },
  unknown: { heading: 'We do not recognise this order', detail: 'This page does not know the order it was asked about. Nothing can be said about a payment from here. If you were charged, the payment processor receipt sent to your email is the record; you can also request a consultation and the clinic will help.' },
};

export function ReturnPage({ returned, state, learnHref, consultHref }: { returned: 'success' | 'cancel' | 'unknown'; state: OrderState | 'unknown'; learnHref: string | null; consultHref: string | null }) {
  const words = RETURN_WORDS[state];
  return (
    <article data-testid="return-page" data-returned={returned} data-state={state} className="w-full">
      <header className={`${SECTION} pt-14`}>
        <p className="m-0 text-[12px] font-bold uppercase tracking-[0.08em] text-subtle">Returning from checkout</p>
        <h1 className="m-0 mt-2 text-[30px] font-bold leading-[1.15] text-body">{words.heading}</h1>
        <p className="m-0 mt-3 text-[15px] leading-relaxed text-body" data-testid="return-detail">{words.detail}</p>
        {returned === 'success' && state !== 'payment_verified' && (
          <p className="m-0 mt-3 text-[13.5px] leading-relaxed text-subtle" data-testid="return-not-proof">Being sent to this page is not proof of payment; only the confirmation from the payment processor is.</p>
        )}
      </header>
      <section className={`${SECTION} rounded-[12px] bg-card`}>
        <p className="m-0 flex flex-wrap items-center gap-3">
          {learnHref && <a href={learnHref} className="underline" data-testid="return-learn">Back to the program page</a>}
          {consultHref && <a href={consultHref} className={BUTTON} data-testid="return-consult">Request a consultation</a>}
        </p>
      </section>
      <footer className={`${SECTION} border-t border-line`}>
        <p className="m-0 text-[12.5px] leading-relaxed text-subtle">This page is operated by The Holistic Approach LLC. No payment details are entered here, and nothing on this page is medical advice.</p>
      </footer>
    </article>
  );
}
