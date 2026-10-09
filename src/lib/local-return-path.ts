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
