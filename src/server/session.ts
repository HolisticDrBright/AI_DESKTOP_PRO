import { cookies } from "next/headers";
import { readAuthSession, type AuthSessionState } from "@/adapters/auth.server";

/**
 * Request-scoped session access for APP-ROUTER files only (route handlers,
 * server components, layouts). This is deliberately the single place the auth
 * cookies meet next/headers — adapter modules stay free of it so they never
 * drag server-only APIs into the client module graph.
 */

export interface RequestSession extends AuthSessionState {
  /** Fresh access token to present to the backend, or null (fall back/deny). */
  token: string | null;
}

export async function getRequestSession(): Promise<RequestSession> {
  try {
    const store = await cookies();
    const s = readAuthSession(store);
    return { ...s, token: s.signedIn ? s.accessToken : null };
  } catch {
    // Outside a request scope (build/prerender) — no session.
    return { signedIn: false, email: null, expired: false, expiresAt: null, token: null };
  }
}
