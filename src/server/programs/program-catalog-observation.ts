if (typeof window !== 'undefined') {
  throw new Error('programs/program-catalog-observation is server-only.');
}

import {
  governedCatalogProductPage, productionCatalogReferencePage, PROGRAM_CATALOG_OBSERVATION_CONTRACT,
  type ObservedCatalogProduct, type ProgramCatalogObservation,
} from '@/contracts/programCatalogObservation';
import { readBoundedRequestBody } from '@/server/bounded-request-body';

/**
 * The Studio's read of the governed catalog: the practitioner's workforce JWT is presented to
 * the selected versioned catalog API, every page is
 * checked against the published envelope, the service target is required to be the same on
 * every page, and the result is narrowed by the practitioner's words on this side. Nothing is
 * cached, nothing is written, no commercial offer or clinical payload leaves this module.
 *
 * Every failure is a category the panel can state honestly: a session that needs renewing, an
 * identity the service refused, a service that could not be reached, and a reply that could not
 * be verified are four different claims, and none of them is "no products match".
 */
export type CatalogObservationFailure =
  | 'reauth_required' | 'identity_refused' | 'service_unavailable' | 'catalog_unverifiable' | 'catalog_target_changed';

export class CatalogObservationError extends Error {
  constructor(readonly category: CatalogObservationFailure) {
    super(category);
    this.name = 'CatalogObservationError';
  }
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const PAGE_BYTES = 1_000_000;
const PAGE_TIMEOUT_MS = 20_000;

/** The workforce API origin this process may call, or null when the configured value is not that. */
export function workforceApiOrigin(value: string | undefined): string | null {
  let origin: URL;
  try { origin = new URL(value ?? ''); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || origin.port
    || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname)) return null;
  return origin.origin;
}

/** Narrowing is a plain, case-insensitive substring match on the display name or the stable id. It never infers. */
export function normaliseCatalogQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}
export function productMatchesQuery(product: Pick<ObservedCatalogProduct, 'displayName' | 'stableId'>, query: string): boolean {
  const q = normaliseCatalogQuery(query);
  return q === '' || product.displayName.toLowerCase().includes(q) || product.stableId.toLowerCase().includes(q);
}

export async function observeProgramCatalog(input: {
  token: string;
  clinic: string;
  versionId: string;
  query: string;
  origin: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxPages?: number;
  source?: 'legacy-synthetic' | 'production-reference';
}): Promise<ProgramCatalogObservation> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxPages = input.maxPages ?? MAX_PAGES;
  const all: ObservedCatalogProduct[] = [];
  const seenCursors = new Set<string>();
  let target: ProgramCatalogObservation['target'] | null = null;
  let cursor: string | undefined;
  let complete = false;
  const source = input.source ?? 'legacy-synthetic';

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(input.origin + (source === 'production-reference'
      ? '/clinical-core/workforce/catalog/reference'
      : '/clinical-core/workforce/catalog/products'));
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchImpl(url.toString(), {
          method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
          headers: {
            authorization: 'Bearer ' + input.token,
            accept: 'application/json',
            'x-alp-selected-organization-id': input.clinic,
          },
        });
      } catch {
        throw new CatalogObservationError('service_unavailable');
      }
      // Aurora may still be resuming when a read-only page first reaches the catalog. Retry
      // that same page once; never replay a mutation, a refused identity, or an invalid reply.
      if (attempt === 0 && [429, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      break;
    }
    if (!response) throw new CatalogObservationError('service_unavailable');
    if (response.status === 401) throw new CatalogObservationError('reauth_required');
    if (response.status === 403) throw new CatalogObservationError('identity_refused');
    if (!response.ok) throw new CatalogObservationError('service_unavailable');
    if (!response.headers.get('content-type')?.includes('application/json')) throw new CatalogObservationError('catalog_unverifiable');
    let decoded: unknown;
    try {
      const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) }, PAGE_BYTES, PAGE_TIMEOUT_MS);
      decoded = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new CatalogObservationError('catalog_unverifiable');
    }
    let environment: ProgramCatalogObservation['target'];
    let next: string | undefined;
    if (source === 'production-reference') {
      const parsed = productionCatalogReferencePage.safeParse(decoded);
      if (!parsed.success) throw new CatalogObservationError('catalog_unverifiable');
      const body = parsed.data;
      environment = body.environment;
      next = body.data.nextCursor ?? undefined;
      for (const product of body.data.products) {
        all.push({
          stableId: product.productId, version: product.productVersion, displayName: product.displayName,
          productType: product.productType, accessTier: product.accessTier,
          declaredRestricted: product.declaredRestricted, directOrderAllowed: product.declaredDirectOrderAllowed,
          labelVersion: null, labelVersionId: product.labelVersionId, sourceVerified: product.sourceVerified,
        });
      }
    } else {
      const parsed = governedCatalogProductPage.safeParse(decoded);
      if (!parsed.success || parsed.data.environment !== 'synthetic-staging') throw new CatalogObservationError('catalog_unverifiable');
      const body = parsed.data;
      environment = body.environment;
      next = body.data.nextCursor;
      for (const product of body.data.products) {
        all.push({
          stableId: product.stableId, version: product.version, displayName: product.displayName,
          productType: product.productType, accessTier: product.accessTier,
          declaredRestricted: product.declaredRestricted, directOrderAllowed: product.directOrderAllowed,
          labelVersion: product.label ? product.label.version : null,
        });
      }
    }
    if (target === null) target = environment;
    else if (target !== environment) throw new CatalogObservationError('catalog_target_changed');
    if (!next) { complete = true; break; }
    if (seenCursors.has(next)) throw new CatalogObservationError('catalog_unverifiable');
    seenCursors.add(next);
    cursor = next;
  }
  if (target === null) throw new CatalogObservationError('catalog_unverifiable');

  // One identity per stable id: a catalog that reports the same product twice in one read is not
  // one the Studio can bind against, because "the observed release" would then be two numbers.
  const ids = new Set<string>();
  for (const product of all) {
    if (ids.has(product.stableId)) throw new CatalogObservationError('catalog_unverifiable');
    ids.add(product.stableId);
  }

  return {
    contractVersion: PROGRAM_CATALOG_OBSERVATION_CONTRACT,
    clinic: input.clinic,
    versionId: input.versionId,
    target,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    query: input.query,
    products: all.filter(product => productMatchesQuery(product, input.query)),
    catalogSize: all.length,
    complete,
  };
}
