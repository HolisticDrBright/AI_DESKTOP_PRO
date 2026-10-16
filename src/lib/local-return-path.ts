/** Auth transitions must never turn an untrusted return path into an external
 * navigation. Browsers normalize backslashes and strip control characters. */
export function localReturnPath(value: string | null, fallback: "/" | "/patients" = "/"): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\u0000-\u0020\u007f]/.test(value)) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(decoded)) return fallback;
    const url = new URL(value, "https://local-return.invalid");
    if (url.origin !== "https://local-return.invalid" || url.pathname.startsWith("//")) return fallback;
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}

/**
 * Where a completed sign-in goes, from the server's clinic step (reported under clinic-membership sign-in only): no
 * active clinic goes to onboarding; several, or clinics that could not be read, go to an explicit choice that then
 * returns to `next`; a single selected clinic, or no step at all (the legacy default), goes straight to `next`.
 */
export function afterSignInPath(clinicStep: unknown, next: string): string {
  if (clinicStep === "onboard") return "/apply";
  if (clinicStep === "choose" || clinicStep === "unknown") return `/select-clinic?next=${encodeURIComponent(next)}`;
  return next;
}
