import { funnelTextIssue } from '@/funnels/schema';
import type { LeadProgram } from '@/contracts/leadCampaigns';

/**
 * A check every campaign email must pass before it is scheduled in Dittofeed (run by whoever approves
 * the text; Dittofeed itself cannot run it).
 *
 * - **The funnel text rules apply to every email.** No dose, drug or brand name, promised change, cure,
 *   reversal or guarantee, and, for email, no claim to treat or heal.
 * - **Every email carries:**
 *   - a working unsubscribe link (Dittofeed's own tag, which also sets the one-click headers);
 *   - the sender's name;
 *   - the physical mailing address.
 * - **It links to exactly one place:** that program's own page with `?via=email`, so a reader who goes on
 *   to request a consultation arrives through the program's email consult link. No other address
 *   appears, not even the consult page itself.
 * - **No personal value is filled in except the first name.** Which program a person chose, or anything
 *   about them, never appears.
 * - **A `[[…]]` slot left in a template is unfilled**, and the email is not sendable.
 */
const ALLOWED_TAGS = /\{%\s*(?:unsubscribe_link|unsubscribe_url|subscription_management_link|subscription_management_url|view_in_browser_url)\s*%\}/g;
const ALLOWED_VARIABLE = /\{\{\s*user\.firstName\s*(?:\|\s*default:\s*'[A-Za-z ]{0,20}'\s*)?\}\}/g;
const TREATMENT_CLAIM = /\b(?:treats?|treated|treating|heals?|healed|healing)\b/i;

/** The one address a program's campaign email may link to: its page on the public site, marked as the email channel. */
export function programPageEmailUrl(siteOrigin: string, program: LeadProgram): string {
  const origin = new URL(siteOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('site_origin_invalid');
  return `${origin.origin}/learn/${program}?via=email`;
}

export function campaignEmailProblems(email: { subject: string; body: string }, rules: { senderName: string; mailingAddress: string; programPageUrl: string }): string[] {
  const problems: string[] = [];
  const all = `${email.subject}\n${email.body}`;
  if (!/\{%\s*unsubscribe_(?:link|url)\s*%\}/.test(email.body)) problems.push('no unsubscribe link');
  if (!email.body.includes(rules.mailingAddress)) problems.push('no mailing address');
  if (!email.body.includes(rules.senderName)) problems.push('no sender name');
  if (!email.body.includes(rules.programPageUrl)) problems.push('no link to the program page');
  if (/\[\[[^\]]*\]\]/.test(all)) problems.push('an unfilled placeholder');
  let rest = all.replace(ALLOWED_TAGS, ' ').replace(ALLOWED_VARIABLE, ' ').split(rules.programPageUrl).join(' ');
  if (/\{\{|\{%/.test(rest)) problems.push('only the first name may be filled in from the reader');
  rest = rest.replace(/<[^>]{0,500}>/g, ' ').split(rules.mailingAddress).join(' ').replace(/\[\[[^\]]*\]\]/g, ' ');
  const issue = funnelTextIssue(rest);
  if (issue) problems.push(issue);
  if (TREATMENT_CLAIM.test(rest)) problems.push('no claim to treat or heal');
  return problems;
}
