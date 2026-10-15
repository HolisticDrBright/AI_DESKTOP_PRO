import { LEAD_PROGRAM_LABEL, leadConsentText, type LeadProgram } from '@/contracts/leadCampaigns';

/**
 * The sign-up service's pages and its one email, as fixed templates. Every interpolated value is
 * escaped. No script, image, font, frame or third-party request; the only form posts to this service.
 * Wording is DRAFT until Brandon approves it: every word here is covered by CAMPAIGN_TEXT_VERSION, and the
 * service shows the form and sends the email only once that exact version is recorded as approved.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
});
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>`
    + `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}label{display:block;margin:.75rem 0 .25rem}input[type=email],input[type=text]{width:100%;padding:.5rem}button{margin-top:1rem;padding:.6rem 1rem}.small{color:#555;font-size:.9rem}</style>`
    + `</head><body>${body}</body></html>`;
}

export function signupPage(program: LeadProgram, error: 'invalid' | null = null) {
  const label = LEAD_PROGRAM_LABEL[program];
  return page(`Get updates about the ${label}`, `<h1>Get updates about the ${escape(label)}</h1>`
    + (error ? '<p role="alert">Please enter a valid email address and tick the box to continue.</p>' : '')
    + `<form method="post" action="/signup"><input type="hidden" name="program" value="${escape(program)}">`
    + '<label for="email">Email address</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email">'
    + '<label for="firstName">First name (optional)</label><input id="firstName" name="firstName" type="text" maxlength="40" autocomplete="given-name">'
    + `<p><label><input type="checkbox" name="consent" value="yes"> ${escape(leadConsentText(program))}</label></p>`
    + '<button type="submit">Send me a confirmation email</button></form>'
    + '<p class="small">We will email you once to confirm. Nothing else is sent unless you confirm. Please do not include health information.</p>');
}
/** Sending is not configured or the text is not approved: no form, nothing collected, nothing sent. */
export function closedPage(program: LeadProgram) {
  const label = LEAD_PROGRAM_LABEL[program];
  return page(`Updates about the ${label} are not open yet`, `<h1>Updates about the ${escape(label)} are not open yet</h1>`
    + '<p>Email updates for this program have not started. Nothing was collected and nothing was sent. You can still request a consultation from the program page.</p>');
}
/** The same page for every valid address, so the page never reveals who is already on a list. */
export function checkEmailPage() {
  return page('Check your email', '<h1>Check your email</h1><p>If the address is right, a confirmation email is on its way. Click the link in it to start receiving updates. If you do not confirm, you will not hear from us.</p>');
}
export function sendFailedPage() {
  return page('We could not send the email', '<h1>We could not send the confirmation email</h1><p>Nothing was saved. Please try again later.</p>');
}
/** Opening the link shows a button; only the button confirms, so a link scanner cannot confirm for the reader. */
export function confirmPage(token: string, program: LeadProgram) {
  return page('Confirm your subscription', `<h1>Confirm your subscription</h1><p>Confirm that you want email updates about the ${escape(LEAD_PROGRAM_LABEL[program])}.</p>`
    + `<form method="post" action="/confirm"><input type="hidden" name="t" value="${escape(token)}"><button type="submit">Yes, send me updates</button></form>`);
}
export function confirmedPage(program: LeadProgram) {
  return page('You are subscribed', `<h1>You are subscribed</h1><p>You will receive email updates about the ${escape(LEAD_PROGRAM_LABEL[program])}. Every email has an unsubscribe link, and you can stop at any time.</p>`);
}
export function linkProblemPage(reason: 'invalid' | 'expired') {
  return reason === 'expired'
    ? page('This link has expired', '<h1>This link has expired</h1><p>Confirmation links last 72 hours. You can sign up again from the program page.</p>')
    : page('This link does not work', '<h1>This link does not work</h1><p>Please use the link exactly as it arrived in the email, or sign up again.</p>');
}
export function unavailablePage() {
  return page('Please try again later', '<h1>Please try again later</h1><p>We could not complete this just now. Nothing was changed.</p>');
}

export function confirmationEmail(input: { program: LeadProgram; firstName: string | null; confirmUrl: string; senderName: string; mailingAddress: string }) {
  const label = LEAD_PROGRAM_LABEL[input.program];
  return {
    subject: `Confirm your email to get updates about the ${label}`,
    text: `${input.firstName ? `Hello ${input.firstName},` : 'Hello,'}\n\n`
      + `Someone asked for email updates about the ${label} using this address. To confirm, open this link and press the button:\n\n${input.confirmUrl}\n\n`
      + 'The link lasts 72 hours. If you did not ask for this, ignore this email: you will not be added to any list and will not hear from us again.\n\n'
      + `${input.senderName}\n${input.mailingAddress}\n`,
  };
}
