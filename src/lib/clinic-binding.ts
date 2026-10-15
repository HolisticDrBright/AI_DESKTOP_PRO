import { CLINIC_BINDING_HEADER, EXPECTED_CLINIC_HEADER } from "./clinic-binding-headers";

/**
 * The browser half of the stale-tab clinic fence (the server half is src/server/clinic-fence.ts).
 *
 * Each tab keeps, in memory only, the binding token of the clinic and account its content was produced under: from the
 * page that rendered it (`ClinicBindingMark`) or, on a page with no server-rendered clinical content, from the first
 * live answer. Every same-origin `/api/live/` call then carries it, so the server can refuse a tab whose clinic was
 * switched elsewhere. An answer produced under a different binding than the tab's is turned into the same "clinic
 * changed" refusal rather than shown. Nothing is kept in local or session storage, and the token is never authority.
 */
let tabBinding: string | null = null;
let installed = false;

/** A server-rendered page's binding: the content on screen was produced under it. */
export function setTabClinicBinding(token: string | null): void {
  if (token) tabBinding = token;
}

export function currentTabClinicBinding(): string | null {
  return tabBinding;
}

function clinicChanged(): Response {
  return new Response(JSON.stringify({ error: { code: "conflict",
    message: "Your clinic changed in another window. Reload to continue." } }), {
    status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function liveRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/live/") ? url : null;
  } catch {
    return null;
  }
}

/** Wrap this tab's `fetch` once. Requests to anything but this origin's `/api/live/` pass through untouched. */
export function installClinicBindingFence(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!liveRequestUrl(input)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const sentWith = tabBinding;
    if (sentWith) headers.set(EXPECTED_CLINIC_HEADER, sentWith);
    else headers.delete(EXPECTED_CLINIC_HEADER);
    const response = await original(input, { ...init, headers });
    const answeredUnder = response.headers.get(CLINIC_BINDING_HEADER);
    if (answeredUnder) {
      if (!tabBinding) tabBinding = answeredUnder;
      else if (answeredUnder !== tabBinding) return clinicChanged();
    }
    return response;
  };
}

/** Test seam only. */
export function resetClinicBindingFenceForTests(): void {
  tabBinding = null;
  installed = false;
}
