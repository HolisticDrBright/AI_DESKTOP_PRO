import { NextResponse } from 'next/server';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { CampaignApiError, campaignApiCall, campaignEngineEnabled } from '@/server/campaign-api';

/**
 * The sign-up form's target (a plain HTML form post; the page has no script). It forwards the fixed fields to the
 * campaign engine and redirects: to /join/sent whatever happened to the address (the engine answers the same either
 * way), or back to the form with a problem the visitor can fix. Nothing is logged, stored or set as a cookie here.
 */
const FIELDS = ['practice', 'program', 'email', 'firstName', 'consent', 'formToken', 'website'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;
const redirect = (request: Request, path: string) => NextResponse.redirect(new URL(path, `https://${request.headers.get('host') ?? 'localhost'}`), 303);

export async function POST(request: Request) {
  if (!campaignEngineEnabled()) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!sameBrowserOrigin(request)) return NextResponse.json({ error: 'refused' }, { status: 403 });
  let form: URLSearchParams;
  try { form = new URLSearchParams(new TextDecoder().decode(await readBoundedRequestBody(request, 4096, 5000))); }
  catch { return NextResponse.json({ error: 'invalid' }, { status: 400 }); }
  const practice = form.get('practice') ?? '', program = form.get('program') ?? '';
  if (!SLUG.test(practice) || !SLUG.test(program) || [...form.keys()].some(key => !(FIELDS as readonly string[]).includes(key))) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const back = (problem: string) => redirect(request, `/join/${practice}/${program}?problem=${problem}`);
  if (form.get('consent') !== 'yes') return back('consent');
  const body = Object.fromEntries(FIELDS.flatMap(key => { const value = form.get(key); return value === null || (key === 'firstName' && !value.trim()) ? [] : [[key, value]]; }));
  try {
    await campaignApiCall({ method: 'POST', path: '/campaigns/public/join', body });
    return redirect(request, '/join/sent');
  } catch (error) {
    if (error instanceof CampaignApiError && error.status === 400) return back(error.detail === 'first_name_invalid' ? 'first_name' : 'email');
    return back('unavailable');
  }
}
