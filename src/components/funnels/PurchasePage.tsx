import type { FunnelDefinition } from '@/funnels';
import { formatAmount, type PurchaseAvailability } from '@/contracts/programOffers';

/**
 * The purchase page the buy choice leads to, rendered on the server from the funnel and the offer the
 * server read. It shows the exact terms a visitor would agree to (the price, how it is billed, the
 * program version it covers, the access duration where decided) and what a purchase does NOT include.
 * Starting checkout is a separate boundary (program-checkout, a later unit); until it is connected and
 * configured the page says so and offers the consult address instead. No price is shown unless the
 * offer is available, and nothing on this page takes a payment detail.
 */
const SECTION = 'mx-auto w-full max-w-[760px] px-5 py-8 md:px-8';
const BUTTON = 'inline-flex h-11 items-center rounded-lg bg-action px-5 text-[15px] font-semibold text-white';

export type CheckoutStart =
  | { ready: false; reason: 'checkout_unconfigured' | 'commerce_disabled'; explanation: string };

export function PurchasePage({ funnel, consultHref, purchase, checkout, learnHref }: { funnel: FunnelDefinition; consultHref: string; purchase: PurchaseAvailability; checkout: CheckoutStart; learnHref: string }) {
  return (
    <article data-testid="purchase-page" data-slug={funnel.slug} data-purchase={purchase.available ? 'available' : purchase.reason} className="w-full">
      <header className={`${SECTION} pt-14`}>
        <p className="m-0 text-[12px] font-bold uppercase tracking-[0.08em] text-subtle">{funnel.programLabel}</p>
        <h1 className="m-0 mt-2 text-[30px] font-bold leading-[1.15] text-body">Buy the {funnel.programLabel}</h1>
        <p className="m-0 mt-3 text-[15px] leading-relaxed text-body"><a href={learnHref} className="underline">Back to the program page</a></p>
      </header>
      {purchase.available ? (
        <section className={SECTION} data-testid="purchase-terms">
          <h2 className="m-0 text-[22px] font-bold leading-tight text-body">What you would be buying</h2>
          <dl className="mt-3 text-[15px] leading-relaxed text-body">
            <dt className="font-semibold">Price</dt><dd className="m-0 mb-2">{formatAmount(purchase.pricing)}</dd>
            <dt className="font-semibold">What it covers</dt><dd className="m-0 mb-2">{purchase.name}: the program lessons and habits as published in version {purchase.curriculum.version}. If the clinic publishes a new version after you buy, your access follows the saved terms of your purchase.</dd>
            <dt className="font-semibold">How long</dt><dd className="m-0 mb-2">{purchase.accessDurationDays === null ? 'The access duration has not been decided; it will be shown here before any purchase can start.' : `${purchase.accessDurationDays} days of access from the day the purchase is confirmed.`}</dd>
            <dt className="font-semibold">Terms</dt><dd className="m-0 mb-2">Access terms version {purchase.accessTermsVersion}.</dd>
          </dl>
          <p className="m-0 mt-3 text-[14px] leading-relaxed text-body" data-testid="purchase-excludes">
            A purchase does not include a consultation, a prescription, a supplement, any clinical decision, or a connection to the clinic. Those are separate choices made by you and a practitioner.
          </p>
          <p className="mt-5 flex flex-wrap items-center gap-3" data-testid="purchase-start" data-ready={checkout.ready ? 'true' : 'false'}>
            <span className="text-[13.5px] text-subtle">Checkout is not available yet. {checkout.explanation}</span>
          </p>
        </section>
      ) : (
        <section className={SECTION} data-testid="purchase-unavailable" data-reason={purchase.reason}>
          <h2 className="m-0 text-[22px] font-bold leading-tight text-body">Direct purchase is not available right now</h2>
          <p className="m-0 mt-3 text-[15px] leading-relaxed text-body">{purchase.explanation}</p>
          <p className="m-0 mt-3 text-[15px] leading-relaxed text-body">You can still request a consultation; the clinic will reply with times.</p>
        </section>
      )}
      <section className={`${SECTION} rounded-[12px] bg-card`} data-testid="purchase-consult">
        <h2 className="m-0 text-[22px] font-bold leading-tight text-body">Prefer to talk first?</h2>
        <p className="m-0 mt-3 text-[15px] leading-relaxed text-body">A consultation is free to request on this site and is reviewed by a person. It is not needed to buy the program, and buying the program does not book one.</p>
        <p className="mt-5"><a href={consultHref} className={BUTTON} data-testid="purchase-cta-consult">Request a consultation</a></p>
      </section>
      <footer className={`${SECTION} border-t border-line`}>
        <p className="m-0 text-[12.5px] leading-relaxed text-subtle">
          {funnel.programLabel} is offered by The Holistic Approach LLC. No payment details are entered on this page; a purchase is completed on a separate secure checkout page run by the payment processor. This page is not medical advice and does not replace your own doctor.
        </p>
      </footer>
    </article>
  );
}
