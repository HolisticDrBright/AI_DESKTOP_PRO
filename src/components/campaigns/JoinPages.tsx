import type { JoinPageInfo } from '@/campaigns/contract';

/**
 * The public sign-up pages, as plain server-rendered HTML: no script, no third-party request, no tracking. The form
 * posts to this origin only. Every answer after a sign-up is the same, so nothing here says whether an address was
 * already on a list.
 */
const PROBLEMS: Record<string, string> = {
  consent: 'Tick the box to say you want these emails, or leave this page.',
  email: 'That email address does not look right. Check it and try again.',
  first_name: 'Use letters only for your first name, or leave it empty.',
  unavailable: 'Sign-up is not available right now. Nothing was saved. Please try again later.',
};
const shell = (children: React.ReactNode) => (
  <main className="mx-auto max-w-[560px] px-5 py-10 text-[15px] leading-relaxed text-body" data-testid="join-page">{children}</main>
);

export function JoinForm({ info, practice, problem }: { info: JoinPageInfo; practice: string; problem: string | null }) {
  return shell(<>
    <h1 className="text-[22px] font-bold">Get updates about the {info.programLabel}</h1>
    <p className="mt-2">From {info.practiceName}. A few welcome emails, then occasional updates. No health questions are asked here.</p>
    {problem && PROBLEMS[problem] ? <p role="alert" className="mt-4 text-critical" data-testid="join-problem">{PROBLEMS[problem]}</p> : null}
    <form method="post" action="/api/public/campaigns/join" className="mt-6 space-y-4">
      <input type="hidden" name="practice" value={practice} />
      <input type="hidden" name="program" value={info.programKey} />
      <input type="hidden" name="formToken" value={info.formToken} />
      {/* Left empty by people; a bot that fills it is answered the same and nothing happens. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
        <label>Website <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
      </div>
      <label className="block">Email address
        <input type="email" name="email" required maxLength={254} autoComplete="email" className="mt-1 block w-full rounded border px-3 py-2" />
      </label>
      <label className="block">First name (optional)
        <input type="text" name="firstName" maxLength={40} autoComplete="given-name" className="mt-1 block w-full rounded border px-3 py-2" />
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="consent" value="yes" required className="mt-1" />
        <span data-testid="join-consent">{info.consentLine}</span>
      </label>
      <button type="submit" className="rounded-lg bg-action px-4 py-2 font-semibold text-white">Sign up</button>
    </form>
    <p className="mt-6 text-[13px] text-subtle">You will get one email asking you to confirm. Nothing else is sent unless you click it, and every email has an unsubscribe link.</p>
  </>);
}

export function JoinUnavailable() {
  return shell(<p role="alert" data-testid="join-unavailable">This sign-up page can&apos;t be shown right now. Nothing was saved. Please try again later.</p>);
}

export function JoinSent() {
  return shell(<>
    <h1 className="text-[22px] font-bold">Check your email</h1>
    <p className="mt-2" data-testid="join-sent">If the address can receive these updates, an email asking you to confirm is on its way. Nothing more is sent unless you click the link in it.</p>
  </>);
}

const CONFIRMED: Record<string, { text: string; alert: boolean }> = {
  confirmed: { text: 'You are signed up. The first email is on its way. Every email has a one-click unsubscribe link.', alert: false },
  expired: { text: 'This link has expired. Sign up again from the program page to get a new one.', alert: true },
  invalid: { text: 'This link is not valid. Nothing was changed.', alert: true },
  list_full: { text: 'This practice cannot add new subscribers right now, so you were not added. Nothing more will be sent.', alert: true },
  unavailable: { text: 'Confirmation is not available right now. Nothing was changed. Please try the link again later.', alert: true },
};
export function JoinConfirm({ token, outcome }: { token: string | null; outcome: string | null }) {
  if (outcome) {
    const message = CONFIRMED[outcome] ?? CONFIRMED.unavailable!;
    return shell(<p role={message.alert ? 'alert' : 'status'} data-testid={`join-confirm-${CONFIRMED[outcome] ? outcome : 'unavailable'}`}>{message.text}</p>);
  }
  if (!token) return shell(<p role="alert" data-testid="join-confirm-invalid">{CONFIRMED.invalid!.text}</p>);
  return shell(<>
    <h1 className="text-[22px] font-bold">Confirm your sign-up</h1>
    <p className="mt-2">Press the button to start receiving the emails you asked for.</p>
    <form method="post" action="/api/public/campaigns/confirm" className="mt-4">
      <input type="hidden" name="t" value={token} />
      <button type="submit" className="rounded-lg bg-action px-4 py-2 font-semibold text-white" data-testid="join-confirm-button">Confirm</button>
    </form>
  </>);
}

export function JoinUnsubscribed({ outcome }: { outcome: 'unsubscribed' | 'invalid' | 'unavailable' }) {
  const text = outcome === 'unsubscribed' ? 'You are unsubscribed. No more emails will be sent to you from this list.'
    : outcome === 'invalid' ? 'This unsubscribe link is not valid. If you keep receiving emails, reply to one of them and ask to be removed.'
      : 'Unsubscribing is not available right now. Please try the link again in a few minutes.';
  return shell(<p role={outcome === 'unsubscribed' ? 'status' : 'alert'} data-testid={`join-unsubscribe-${outcome}`}>{text}</p>);
}
