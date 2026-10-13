import { funnelTextIssue } from '@/funnels/schema';

/**
 * A check every campaign email must pass before it is scheduled in Dittofeed (run by whoever approves
 * the text; Dittofeed itself cannot run it). The funnel text rules apply to every email: no dose, drug
 * or brand name, promised change, cure or guarantee. Every email also carries a working unsubscribe
 * link (Dittofeed's own tag, which also sets the one-click headers), the sender's name and the
 * physical mailing address. The only addresses allowed are the consult page and Dittofeed's own
 * unsubscribe and preference tags. No personal value other than the first name is interpolated:
 * which program a person chose, or anything about them, never appears.
 */
const ALLOWED_TAGS = /\{%\s*(?:unsubscribe_link|unsubscribe_url|subscription_management_link|subscription_management_url|view_in_browser_url)\s*%\}/g;
const ALLOWED_VARIABLE = /\{\{\s*user\.firstName\s*(?:\|\s*default:\s*'[A-Za-z ]{0,20}'\s*)?\}\}/g;
export function campaignEmailProblems(email: { subject: string; body: string }, rules: { senderName: string; mailingAddress: string; consultUrls: readonly string[] }): string[] {
  const problems: string[] = [];
  const all = `${email.subject}\n${email.body}`;
  if (!/\{%\s*unsubscribe_(?:link|url)\s*%\}/.test(email.body)) problems.push('no unsubscribe link');
  if (!email.body.includes(rules.mailingAddress)) problems.push('no mailing address');
  if (!email.body.includes(rules.senderName)) problems.push('no sender name');
  let rest = all.replace(ALLOWED_TAGS, ' ').replace(ALLOWED_VARIABLE, ' ');
  for (const url of rules.consultUrls) rest = rest.split(url).join(' ');
  if (/\{\{|\{%/.test(rest)) problems.push('only the first name may be filled in from the reader');
  rest = rest.replace(/<[^>]{0,500}>/g, ' ').split(rules.mailingAddress).join(' ');
  const issue = funnelTextIssue(rest);
  if (issue) problems.push(issue);
  return problems;
}
