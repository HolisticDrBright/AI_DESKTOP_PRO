/**
 * The public web address and the indexing posture, from configuration only.
 *
 * No host name is written anywhere in source: canonical addresses, the sitemap and the consult
 * link all come from `NEXT_PUBLIC_SITE_ORIGIN`. Search engines are told they may index a funnel
 * page only when that origin is configured, the runtime is the production clinical one, and
 * nothing about the deployment says staging or synthetic. Everywhere else, and whenever the
 * origin is unset, every funnel page is served `noindex` and the sitemap is empty, whatever the
 * definition says.
 */
export type PublicSiteEnv = { readonly [key: string]: string | undefined };

export function publicSiteOrigin(env: PublicSiteEnv = process.env): string | null {
  const raw = (env.NEXT_PUBLIC_SITE_ORIGIN ?? '').trim();
  if (!raw) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  return parsed.origin;
}

export function isStagingOrSynthetic(env: PublicSiteEnv = process.env): boolean {
  const signals = [env.APP_RUNTIME_ENV, env.NEXT_PUBLIC_APP_ENV, env.CLINICAL_AWS_ENVIRONMENT, env.CLINICAL_AWS_RUNTIME_MODE]
    .map(value => String(value ?? '').toLowerCase());
  const origin = publicSiteOrigin(env);
  const host = origin ? new URL(origin).hostname : '';
  return signals.some(value => /staging|synthetic|qualification|development|(^|[.-])(dev|test)([.-]|$)/.test(value))
    || env.CLINICAL_AWS_QUALIFICATION_EXECUTION === 'true'
    || host === '127.0.0.1' || host === '[::1]'
    || /(^|[.-])(staging|synthetic|stage|dev|test|localhost)([.-]|$)/.test(host);
}

/** Indexing is allowed only for the production origin: configured, production runtime, nothing staging or synthetic. */
export function indexingAllowed(env: PublicSiteEnv = process.env): boolean {
  return publicSiteOrigin(env) !== null && String(env.APP_RUNTIME_ENV ?? '') === 'production-clinical' && !isStagingOrSynthetic(env);
}

/** The canonical address of a funnel page, or null when no public address is configured. */
export function funnelPageUrl(slug: string, env: PublicSiteEnv = process.env): string | null {
  const origin = publicSiteOrigin(env);
  return origin ? `${origin}/learn/${slug}` : null;
}
