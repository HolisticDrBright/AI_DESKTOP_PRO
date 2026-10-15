import { NextResponse } from 'next/server';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { campaignApiCall, campaignEngineEnabled } from '@/server/campaign-api';

/**
 * The confirmation button's target. Confirmation needs this POST from the page's button: following the link (GET)
 * only shows the button, so a mail scanner that opens links never confirms anyone.
 */
const OUTCOMES = new Set(['confirmed', 'expired', 'invalid', 'list_full', 'unavailable']);
export async function POST(request: Request) {
  if (!campaignEngineEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!sameBrowserOrigin(request)) return NextResponse.json({ error: 'refused' }, { status: 403 });
  let token = '';
  try { token = new URLSearchParams(new TextDecoder().decode(await readBoundedRequestBody(request, 2048, 5000))).get('t') ?? ''; }
  catch { return NextResponse.json({ error: 'invalid' }, { status: 400 }); }
  let outcome = 'unavailable';
  try { outcome = (await campaignApiCall<{ outcome: string }>({ method: 'POST', path: '/campaigns/public/confirm', body: { token } })).outcome; }
  catch { outcome = 'unavailable'; }
  return NextResponse.redirect(new URL(`/join/confirm?o=${OUTCOMES.has(outcome) ? outcome : 'unavailable'}`, `https://${request.headers.get('host') ?? 'localhost'}`), 303);
}
