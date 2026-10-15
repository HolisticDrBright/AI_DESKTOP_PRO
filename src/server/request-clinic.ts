import { cookies } from "next/headers";
import { AUTH_COOKIES, readAuthSession } from "@/adapters/auth.server";
import { resolveSelectedClinic, type SelectedClinic } from "@/adapters/selected-clinic.server";

/**
 * The selected clinic of the request in progress, bound to the account whose token it carries. Kept apart from
 * `getRequestSession` so code paths that only need the session (the campaign path, for one) never reach the clinical
 * adapters.
 */
export async function getRequestSelectedClinic(): Promise<SelectedClinic> {
  try {
    const store = await cookies();
    const session = readAuthSession(store);
    const values = (name: string) => (store.getAll?.(name) ?? []).map((cookie) => cookie.value);
    return resolveSelectedClinic({
      organizationCookies: values(AUTH_COOKIES.org),
      bindingCookies: values(AUTH_COOKIES.orgBinding),
      token: session.signedIn ? session.accessToken : null,
    });
  } catch {
    // Outside a request scope (build/prerender): nothing is selected.
    return { state: "missing" };
  }
}
