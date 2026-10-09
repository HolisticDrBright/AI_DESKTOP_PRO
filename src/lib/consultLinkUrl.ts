/**
 * The address a consult link is shared as.
 *
 * It is built from the public site origin rather than from whatever host the practitioner's
 * browser happens to be on, because the link is pasted into emails, printed, and read aloud:
 * a link that only works from inside the clinic's own network is worse than no link.
 */
export function consultLinkUrl(slug: string, origin: string | undefined): string | null {
  const base = (origin ?? '').trim();
  if (base.length === 0) return null;
  let parsed: URL;
  try { parsed = new URL(base); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash) return null;
  return `${parsed.origin}/consult/${slug}`;
}
