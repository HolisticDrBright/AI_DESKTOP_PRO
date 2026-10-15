import { funnelTextIssue } from '@/funnels/schema';
import { CAMPAIGN_PROGRAM_LABEL, type CampaignProgram, type EmailBlock, type EmailTemplate, type PracticeSettings, type TemplateDraft } from './contract';

/**
 * The content check every email must pass before it can be approved, and the renderer that turns an approved
 * template into the exact email sent.
 *
 * The check refuses (reusing the funnel rules, `funnelTextIssue`):
 * - any address, markup, dose, drug or brand name, promised amount, cure, reversal or guarantee;
 * - a claim to treat or heal;
 * - any merge field except the first name (with an optional fallback), and any unfilled `[[…]]` slot;
 * - an email with no button to the program page.
 *
 * It also refuses approval while the practice has no sender name or mailing address: every footer carries both.
 */
const TREATMENT_CLAIM = /\b(?:treats?|treated|treating|heals?|healed|healing)\b/i;
const MERGE = /\{\{\s*first_name\s*(?:\|\s*([A-Za-z][A-Za-z ]{0,19}))?\s*\}\}/g;

function blockTexts(block: EmailBlock): string[] {
  if (block.type === 'heading' || block.type === 'paragraph') return [block.text];
  if (block.type === 'button') return [block.label];
  return [block.alt];
}

export function draftProblems(draft: Pick<TemplateDraft, 'subject' | 'blocks'>): string[] {
  const problems = new Set<string>();
  for (const raw of [draft.subject, ...draft.blocks.flatMap(blockTexts)]) {
    if (/\[\[[^\]]*\]\]/.test(raw)) problems.add('an unfilled [[…]] slot');
    const rest = raw.replace(MERGE, ' ');
    if (/\{\{|\}\}|\{%|%\}/.test(rest)) problems.add('only the first name may be filled in from the reader');
    const issue = funnelTextIssue(rest);
    if (issue) problems.add(issue.replace('funnel copy', 'email').replace('on a public page', 'in an email'));
    if (TREATMENT_CLAIM.test(rest)) problems.add('no claim to treat or heal');
  }
  if (!draft.blocks.some(block => block.type === 'button')) problems.add('no button to the program page');
  return [...problems];
}

export function templateProblems(template: Pick<TemplateDraft, 'subject' | 'blocks'>, settings: Pick<PracticeSettings, 'senderName' | 'mailingAddress'>): string[] {
  const problems = draftProblems(template);
  if (!settings.senderName) problems.push('the practice has no sender name, which every footer carries');
  if (!settings.mailingAddress) problems.push('the practice has no mailing address, which every footer carries');
  return problems;
}

/* ------------------------------------------------------------------------------------------ rendering */

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function fillName(text: string, name: string | null): string {
  return text.replace(MERGE, (_match, fallback: string | undefined) => name ?? (fallback ?? 'there').trim());
}

/** The one place an email may lead: that program's page, marked as the email channel. */
export function programPageEmailUrl(siteOrigin: string, program: CampaignProgram): string {
  const origin = new URL(siteOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || origin.port) throw new Error('site_origin_invalid');
  return `${origin.origin}/learn/${program}?via=email`;
}

export type RenderedEmail = { subject: string; html: string; text: string; headers: { name: string; value: string }[] };

export function renderEmail(template: Pick<EmailTemplate, 'programKey' | 'subject' | 'blocks'>, input: {
  settings: Pick<PracticeSettings, 'senderName' | 'mailingAddress'>; siteOrigin: string; unsubscribeUrl: string; oneClickUrl: string; firstName: string | null;
}): RenderedEmail {
  const { senderName, mailingAddress } = input.settings;
  if (!senderName || !mailingAddress) throw new Error('footer_incomplete');
  const page = programPageEmailUrl(input.siteOrigin, template.programKey);
  const label = CAMPAIGN_PROGRAM_LABEL[template.programKey];
  const html: string[] = [], text: string[] = [];
  for (const block of template.blocks) {
    if (block.type === 'heading') { const t = fillName(block.text, input.firstName); html.push(`<h2 style="font-size:20px;margin:16px 0 8px">${escapeHtml(t)}</h2>`); text.push(t.toUpperCase(), ''); }
    if (block.type === 'paragraph') { const t = fillName(block.text, input.firstName); html.push(`<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(t)}</p>`); text.push(t, ''); }
    if (block.type === 'button') { html.push(`<p style="margin:16px 0"><a href="${escapeHtml(page)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f5f5b;color:#ffffff;text-decoration:none">${escapeHtml(block.label)}</a></p>`); text.push(`${block.label}: ${page}`, ''); }
    if (block.type === 'image') { const src = new URL(block.path, input.siteOrigin).toString(); html.push(`<p style="margin:12px 0"><img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" style="max-width:100%"></p>`); }
  }
  const why = `You are receiving this because you asked ${senderName} for email updates about the ${label}.`;
  html.push(`<hr style="border:none;border-top:1px solid #dddddd;margin:24px 0 12px">`,
    `<p style="font-size:12px;color:#555555;line-height:1.5;margin:0">${escapeHtml(why)}<br>${escapeHtml(senderName)}<br>${escapeHtml(mailingAddress)}<br><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#555555">Unsubscribe</a></p>`);
  text.push('--', why, senderName, mailingAddress, `Unsubscribe: ${input.unsubscribeUrl}`);
  return {
    subject: fillName(template.subject, input.firstName),
    html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:16px">${html.join('')}</body></html>`,
    text: text.join('\n'),
    // RFC 8058: a POST to this address unsubscribes at once, with no page in between.
    headers: [{ name: 'List-Unsubscribe', value: `<${input.oneClickUrl}>` }, { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }],
  };
}

/** The confirmation email: the only thing sent before a click. It carries no campaign content. */
export function confirmationEmail(input: { practiceName: string; program: CampaignProgram; confirmUrl: string; mailingAddress: string }): { subject: string; html: string; text: string } {
  const label = CAMPAIGN_PROGRAM_LABEL[input.program];
  const lines = [
    `Someone, hopefully you, asked ${input.practiceName} for email updates about the ${label}.`,
    'Nothing more will be sent unless you confirm. The link works for 48 hours.',
  ];
  const tail = `If this was not you, ignore this email and nothing more will arrive.`;
  return {
    subject: `Please confirm: updates about the ${label}`,
    text: [...lines, '', `Confirm: ${input.confirmUrl}`, '', tail, '', '--', input.practiceName, input.mailingAddress].join('\n'),
    html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:16px">${lines.map(l => `<p style="font-size:15px;line-height:1.5">${escapeHtml(l)}</p>`).join('')}<p><a href="${escapeHtml(input.confirmUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f5f5b;color:#ffffff;text-decoration:none">Confirm</a></p><p style="font-size:13px;color:#555555">${escapeHtml(tail)}</p><p style="font-size:12px;color:#555555">${escapeHtml(input.practiceName)}<br>${escapeHtml(input.mailingAddress)}</p></body></html>`,
  };
}
