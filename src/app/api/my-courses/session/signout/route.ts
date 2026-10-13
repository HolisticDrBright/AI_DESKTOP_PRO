import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { signOut } from '@/server/learner/consumer-signin';

/** Sign out of My courses everywhere: Cognito GlobalSignOut, then the cookies are cleared (src/server/learner/consumer-signin.ts). Same-origin only. */
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  if (!sameBrowserOrigin(request)) return new Response(JSON.stringify({ error: { code: 'origin_refused', message: 'origin_refused' } }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' } });
  return signOut(request);
}
