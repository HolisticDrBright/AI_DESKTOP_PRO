import type { FunnelDefinition, FunnelSection } from '@/funnels';
import { formatAmount, type PurchaseAvailability } from '@/contracts/programOffers';

/**
 * A funnel page, rendered on the server from its definition and the program's offer as the server
 * read it. Fixed sections, plain text, no form control, no image, no script. Two destinations and no
 * more: the consult address built from the configured public origin, and, only when the program's
 * offer is actually available, the same-origin purchase page. When it is not, the page says exactly
 * why in the visitor's words, and prints no address, no price and no promise.
 */
const SECTION = 'mx-auto w-full max-w-[760px] px-5 py-8 md:px-8';
const H2 = 'm-0 text-[22px] font-bold leading-tight text-body';
const P = 'm-0 mt-3 text-[15px] leading-relaxed text-body';
const BUTTON = 'inline-flex h-11 items-center rounded-lg bg-action px-5 text-[15px] font-semibold text-white';

/** `updatesHref`: the campaign service's sign-up page for this program, when one is configured; never a form on this page. */
export type FunnelPageProps = { funnel: FunnelDefinition; consultHref: string; purchase: PurchaseAvailability; buyHref: string; updatesHref?: string | null };

export function FunnelPage({ funnel, consultHref, purchase, buyHref, updatesHref = null }: FunnelPageProps) {
  return (
    <article data-testid="funnel-page" data-slug={funnel.slug} data-purchase={purchase.available ? 'available' : purchase.reason} className="w-full">
      {funnel.sections.map(section => <Section key={section.kind} section={section} consultHref={consultHref} programLabel={funnel.programLabel} purchase={purchase} buyHref={buyHref} updatesHref={updatesHref} />)}
      <footer className={`${SECTION} border-t border-line`} data-testid="funnel-footer">
        <p className="m-0 text-[12.5px] leading-relaxed text-subtle">
          {funnel.programLabel} is offered by The Holistic Approach LLC. This page describes a program and offers two choices: to request a consultation, or to buy the program when it is available. It is not medical advice, a diagnosis or a prescription, and it does not replace your own doctor. No payment details are entered on this page; any purchase is completed on a separate secure checkout page.
        </p>
      </footer>
    </article>
  );
}

/** The buy choice as the visitor reads it: a link when the offer is available, otherwise the specific reason it is not. */
export function PurchaseChoice({ purchase, buyHref, place }: { purchase: PurchaseAvailability; buyHref: string; place: 'top' | 'bottom' }) {
  if (purchase.available) {
    return (
      <span data-testid={`funnel-buy-${place}`} data-available="true">
        <a href={buyHref} className={BUTTON}>Buy the program</a>
        <span className="ml-3 text-[13px] text-subtle">{formatAmount(purchase.pricing)}{purchase.accessDurationDays === null ? '' : `, ${purchase.accessDurationDays} days of access`}</span>
      </span>
    );
  }
  return (
    <span data-testid={`funnel-buy-${place}`} data-available="false" data-reason={purchase.reason} className="text-[13.5px] text-subtle">
      Direct purchase is not available right now. {purchase.explanation}
    </span>
  );
}

function Section({ section, consultHref, programLabel, purchase, buyHref, updatesHref }: { section: FunnelSection; consultHref: string; programLabel: string; purchase: PurchaseAvailability; buyHref: string; updatesHref: string | null }) {
  switch (section.kind) {
    case 'hero':
      return (
        <header className={`${SECTION} pt-14`} data-testid="funnel-section-hero">
          <p className="m-0 text-[12px] font-bold uppercase tracking-[0.08em] text-subtle">{programLabel}</p>
          <h1 className="m-0 mt-2 text-[34px] font-bold leading-[1.15] text-body">{section.heading}</h1>
          <p className={`${P} text-[17px]`}>{section.lead}</p>
          <p className="mt-6 flex flex-wrap items-center gap-3"><a href={consultHref} className={BUTTON} data-testid="funnel-cta-top">Request a consultation</a><PurchaseChoice purchase={purchase} buyHref={buyHref} place="top" /></p>
        </header>
      );
    case 'who-it-is-for':
      return (
        <section className={SECTION} data-testid="funnel-section-who-it-is-for">
          <h2 className={H2}>{section.heading}</h2>
          <ul className="mt-3 list-disc pl-5 text-[15px] leading-relaxed text-body">{section.fits.map(line => <li key={line}>{line}</li>)}</ul>
          {section.notFor && (
            <>
              <h3 className="m-0 mt-5 text-[15px] font-bold text-body">Not for</h3>
              <ul className="mt-2 list-disc pl-5 text-[15px] leading-relaxed text-body">{section.notFor.map(line => <li key={line}>{line}</li>)}</ul>
            </>
          )}
        </section>
      );
    case 'what-is-included':
      return (
        <section className={SECTION} data-testid="funnel-section-what-is-included" data-source={section.source}>
          <h2 className={H2}>{section.heading}</h2>
          {section.source === 'published_program'
            ? <ul className="mt-3 list-disc pl-5 text-[15px] leading-relaxed text-body">{section.items.map(item => <li key={item}>{item}</li>)}</ul>
            : <p className={P}>The contents of this program are being written from the program itself and are not shown yet.</p>}
          {section.note && <p className="m-0 mt-3 text-[13px] text-subtle">{section.note}</p>}
        </section>
      );
    case 'how-it-works':
      return (
        <section className={SECTION} data-testid="funnel-section-how-it-works">
          <h2 className={H2}>{section.heading}</h2>
          <ol className="mt-3 list-decimal pl-5 text-[15px] leading-relaxed text-body">
            {section.steps.map(step => <li key={step.title} className="mt-2"><span className="font-semibold">{step.title}.</span> {step.detail}</li>)}
          </ol>
        </section>
      );
    case 'practitioner':
      return (
        <section className={SECTION} data-testid="funnel-section-practitioner">
          <h2 className={H2}>{section.heading}</h2>
          <p className={`${P} font-semibold`}>{section.name}</p>
          <p className="m-0 text-[13.5px] text-subtle">{section.credentials}</p>
          <p className={P}>{section.about}</p>
        </section>
      );
    case 'faq':
      return (
        <section className={SECTION} data-testid="funnel-section-faq">
          <h2 className={H2}>{section.heading}</h2>
          <dl className="mt-3">
            {section.questions.map(entry => (
              <div key={entry.question} className="mt-4">
                <dt className="m-0 text-[15px] font-semibold text-body">{entry.question}</dt>
                <dd className="m-0 mt-1 text-[15px] leading-relaxed text-body">{entry.answer}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case 'call-to-action':
      return (
        <section className={`${SECTION} rounded-[12px] bg-card`} data-testid="funnel-section-call-to-action">
          <h2 className={H2}>{section.heading}</h2>
          <p className={P}>{section.detail}</p>
          <p className="mt-5 flex flex-wrap items-center gap-3"><a href={consultHref} className={BUTTON} data-testid="funnel-cta">{section.buttonLabel}</a><PurchaseChoice purchase={purchase} buyHref={buyHref} place="bottom" /></p>
          {updatesHref ? <p className="mt-4 text-[14px]"><a href={updatesHref} className="text-action underline" data-testid="funnel-updates">Get updates about this program</a></p> : null}
        </section>
      );
  }
}
