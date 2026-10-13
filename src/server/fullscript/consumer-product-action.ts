if (typeof window !== 'undefined') throw new Error('Fullscript consumer product actions are server-only.');
import { createHash, randomBytes } from 'node:crypto';
import {
  ACTION_LIFETIME_SECONDS, FULLSCRIPT_CONSUMER_ACTION, PURCHASE_ADMISSION, PURCHASE_MAX_AUTH_AGE_SECONDS,
  fullscriptProductDestination, productActionIssued, productActionRedeemed, productActionRedemptionRequest, productActionRequest,
  purchaseAdmissionDeclaration, purchaseAdmissionStatus,
  type AdmissionRefusal, type ProductActionBinding, type ProductActionIssued, type ProductActionRedeemed, type ProductActionRefusal,
  type PurchaseAdmissionDeclaration, type PurchaseAdmissionStatus,
} from '@/contracts/fullscriptConsumerAction';
import type { AwsGovernedCatalogReader, CatalogEnvironment, GovernedCatalogProduct, GovernedCommercialOffer } from '../clinical-core/aws-governed-catalog-reader';

/**
 * Consumer Fullscript product actions and purchase admission: a source-only candidate, disabled.
 *
 * Nothing here is reachable. No route constructs it, the release list is empty, and with no release every
 * call refuses `commerce_disabled` before reading anything. It exists so the later supplement-purchase
 * capability is real code with real refusals, not a placeholder: when a release is reviewed, the AWS route
 * supplies the ports below from durable records and this module decides.
 *
 * What it decides, in order, on issue and again on redemption:
 *  1. a reviewed release for this environment that is in effect (else commerce_disabled);
 *  2. a session that is the caller's own, recent and not revoked (else session_stale);
 *  3. the person's declared jurisdiction and practitioner relationship, validated here against server
 *     records: the release's jurisdictions, the dispensary practitioner's verified jurisdictions, and the
 *     care connection the person named. Never an IP address, a locale or a time zone: the ports carry
 *     none, and an unknown answer refuses;
 *  4. the exact product, label and single offer the person was shown are still the current ones;
 *  5. the offer's address is a Fullscript product page under the release's own dispensary;
 *  6. issue: the request id has never been used; redemption: the action is this account's, from this
 *     session, unexpired and unused, and it is spent atomically.
 */
export type ConsumerPurchaseRelease = {
  contract: 'consumer-purchase-release/1';
  environment: CatalogEnvironment;
  /** `clinician_connected` also requires a verified care connection to the dispensary's clinic. */
  tier: 'consumer' | 'clinician_connected';
  /** Recorded state codes this release covers. Never a wildcard. */
  jurisdictions: readonly string[];
  provider: { name: 'fullscript'; dispensarySlug: string; organizationId: string };
  /** Reviewed copy shown with the action. This module writes none. */
  disclosure: string;
  effectiveFrom: string;
};

/** No purchase capability has been released. The education-only Core launch keeps it this way. */
export const CONSUMER_PURCHASE_RELEASES: readonly ConsumerPurchaseRelease[] = Object.freeze([]);

/** The session the route's authenticator verified. Never fields from the request body. */
export type ConsumerSession = { accountId: string; sessionId: string; authenticatedAt: string; revoked: boolean };
export type CurrentCatalogOffer = { product: GovernedCatalogProduct; offers: GovernedCommercialOffer[] };
export type PatientLink = { connectionId: string; organizationId: string; state: 'invitation_pending' | 'verified' | 'paused' | 'revoked' };
export type AdmissionRecord = { accountId: string; declaration: PurchaseAdmissionDeclaration; declarationSha256: string; recordedAt: string };
export type ProductActionRecord = {
  actionId: string; requestId: string; requestSha256: string; accountId: string; sessionId: string; environment: CatalogEnvironment;
  binding: ProductActionBinding; connectionId: string | null; destinationUrl: string; issuedAt: string; expiresAt: string; redeemedAt: string | null;
};
export type ConsumerPurchasePorts = {
  /** Consumer-audience catalog: null when the product is not openly available to consumers. */
  catalog: { current(productStableId: string): Promise<CurrentCatalogOffer | null> };
  /** Every care connection this account has ever held, revoked ones included. */
  patientLinks: { forAccount(accountId: string): Promise<PatientLink[]> };
  /** Jurisdictions in which the clinic's dispensary practitioner's authority has been verified. */
  practitionerAuthority: { verifiedJurisdictions(organizationId: string): Promise<readonly string[]> };
  admissions: { current(accountId: string): Promise<AdmissionRecord | null>; record(record: AdmissionRecord): Promise<void> };
  actions: {
    /** Inserts unless the request id was ever used, by anyone. False means it was. */
    insertIfNew(record: ProductActionRecord): Promise<boolean>;
    get(actionId: string): Promise<ProductActionRecord | null>;
    /** Sets redeemedAt only while it is still null. False means it was already spent. */
    spend(actionId: string, at: string): Promise<boolean>;
  };
  clock: { now(): Date };
};

export type Refused = { ok: false; refused: ProductActionRefusal };
const refuse = (refused: ProductActionRefusal): Refused => ({ ok: false, refused });
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
/** Key order fixed, so the digest names the request's content and nothing else. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(value);

export function createConsumerPurchaseCandidate(ports: ConsumerPurchasePorts, environment: CatalogEnvironment, releases: readonly ConsumerPurchaseRelease[]) {
  const nowIso = () => ports.clock.now().toISOString();
  const release = (): ConsumerPurchaseRelease | null => {
    const asOf = ports.clock.now().getTime();
    const effective = releases.filter(r => r.contract === 'consumer-purchase-release/1' && r.environment === environment
      && Number.isFinite(Date.parse(r.effectiveFrom)) && Date.parse(r.effectiveFrom) <= asOf && r.jurisdictions.length > 0
      && r.jurisdictions.every(j => /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(j)) && r.disclosure.trim().length > 0);
    // Two releases in effect at once is a review error, not a choice to make here.
    return effective.length === 1 ? effective[0]! : null;
  };
  const sessionFresh = (session: ConsumerSession) => {
    const at = Date.parse(session.authenticatedAt), now = ports.clock.now().getTime();
    return !session.revoked && typeof session.accountId === 'string' && session.accountId.length > 0
      && typeof session.sessionId === 'string' && session.sessionId.length > 0
      && Number.isFinite(at) && at <= now && now - at <= PURCHASE_MAX_AUTH_AGE_SECONDS * 1000;
  };

  async function admission(accountId: string, r: ConsumerPurchaseRelease): Promise<{ ok: true; record: AdmissionRecord; connectionId: string | null } | { ok: false; refused: AdmissionRefusal; record: AdmissionRecord | null }> {
    const record = await ports.admissions.current(accountId);
    if (!record || record.accountId !== accountId) return { ok: false, refused: 'admission_required', record: null };
    const parsed = purchaseAdmissionDeclaration.safeParse(record.declaration);
    if (!parsed.success || record.declarationSha256 !== sha256(canonical(parsed.data))) return { ok: false, refused: 'admission_required', record: null };
    const declaration = parsed.data;
    if (!r.jurisdictions.includes(declaration.jurisdiction)) return { ok: false, refused: 'jurisdiction_not_supported', record };
    const verified = await ports.practitionerAuthority.verifiedJurisdictions(r.provider.organizationId);
    if (!verified.includes(declaration.jurisdiction)) return { ok: false, refused: 'practitioner_jurisdiction_unverified', record };
    if (declaration.practitioner.relationship === 'none') {
      return r.tier === 'clinician_connected' ? { ok: false, refused: 'practitioner_relationship_required', record } : { ok: true, record, connectionId: null };
    }
    // A declared relationship is checked whatever the tier: one the server cannot confirm refuses.
    const { connectionId } = declaration.practitioner;
    const link = (await ports.patientLinks.forAccount(accountId)).filter(l => l.connectionId === connectionId);
    if (link.length !== 1 || link[0]!.state === 'invitation_pending') return { ok: false, refused: 'patient_link_not_found', record };
    if (link[0]!.state === 'revoked') return { ok: false, refused: 'patient_link_revoked', record };
    if (link[0]!.state === 'paused') return { ok: false, refused: 'patient_link_paused', record };
    if (link[0]!.organizationId !== r.provider.organizationId) return { ok: false, refused: 'patient_link_other_clinic', record };
    return { ok: true, record, connectionId };
  }

  async function currentOffer(binding: ProductActionBinding, r: ConsumerPurchaseRelease): Promise<{ ok: true; destinationUrl: string } | Refused> {
    const current = await ports.catalog.current(binding.productStableId);
    if (!current || current.product.stableId !== binding.productStableId) return refuse('product_unavailable');
    const { product } = current;
    if (product.productType !== 'supplement' || product.accessTier !== 'open' || product.declaredRestricted) return refuse('product_restricted');
    if (product.version !== binding.productVersion) return refuse('product_changed');
    if (!product.label) return refuse('label_missing');
    if (product.label.stableId !== binding.labelStableId || product.label.version !== binding.labelVersion) return refuse('label_changed');
    const offers = current.offers.filter(o => o.productStableId === product.stableId);
    if (offers.length > 1) return refuse('multiple_offers');
    if (!product.directOrderAllowed || offers.length === 0) return refuse('offer_unavailable');
    const offer = offers[0]!;
    if (offer.stableId !== binding.offerStableId || offer.version !== binding.offerVersion) return refuse('offer_changed');
    const destination = fullscriptProductDestination(offer.destinationUrl);
    if (!destination || destination.dispensarySlug !== r.provider.dispensarySlug) return refuse('destination_unverified');
    return { ok: true, destinationUrl: offer.destinationUrl };
  }

  async function admissionStatus(session: ConsumerSession): Promise<{ ok: true; status: PurchaseAdmissionStatus } | Refused> {
    const r = release();
    if (!r) return refuse('commerce_disabled');
    if (!sessionFresh(session)) return refuse('session_stale');
    const result = await admission(session.accountId, r);
    const declared = result.record?.declaration ?? null;
    return { ok: true, status: purchaseAdmissionStatus.parse({ contract: PURCHASE_ADMISSION,
      state: declared === null ? 'not_declared' : result.ok ? 'admitted' : 'refused',
      jurisdiction: declared?.jurisdiction ?? null, practitioner: declared?.practitioner.relationship ?? null,
      reason: result.ok || declared === null ? null : result.refused, recordedAt: result.record?.recordedAt ?? null }) };
  }

  return {
    admissionStatus,
    /** Records what the person declared. It admits nothing by itself; `admissionStatus` validates it. */
    async declare(session: ConsumerSession, raw: unknown): Promise<{ ok: true; status: PurchaseAdmissionStatus } | Refused> {
      const r = release();
      if (!r) return refuse('commerce_disabled');
      if (!sessionFresh(session)) return refuse('session_stale');
      const parsed = purchaseAdmissionDeclaration.safeParse(raw);
      if (!parsed.success) return refuse('request_invalid');
      await ports.admissions.record({ accountId: session.accountId, declaration: parsed.data,
        declarationSha256: sha256(canonical(parsed.data)), recordedAt: nowIso() });
      return admissionStatus(session);
    },

    async issue(session: ConsumerSession, raw: unknown): Promise<{ ok: true; issued: ProductActionIssued } | Refused> {
      const r = release();
      if (!r) return refuse('commerce_disabled');
      if (!sessionFresh(session)) return refuse('session_stale');
      const parsed = productActionRequest.safeParse(raw);
      if (!parsed.success) return refuse('request_invalid');
      const request = parsed.data;
      const admitted = await admission(session.accountId, r);
      if (!admitted.ok) return refuse(admitted.refused);
      const offer = await currentOffer(request.binding, r);
      if (!offer.ok) return offer;
      const issuedAt = ports.clock.now(), expiresAt = new Date(issuedAt.getTime() + ACTION_LIFETIME_SECONDS * 1000);
      const record: ProductActionRecord = {
        actionId: `act_${randomBytes(24).toString('base64url')}`, requestId: request.requestId, requestSha256: sha256(canonical(request)),
        accountId: session.accountId, sessionId: session.sessionId, environment, binding: request.binding, connectionId: admitted.connectionId,
        destinationUrl: offer.destinationUrl, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), redeemedAt: null,
      };
      if (!(await ports.actions.insertIfNew(record))) return refuse('request_replayed');
      return { ok: true, issued: productActionIssued.parse({ contractVersion: FULLSCRIPT_CONSUMER_ACTION, environment, provider: 'fullscript',
        data: { actionId: record.actionId, kind: 'product_patient_action', purpose: 'supplement_purchase', binding: record.binding,
          issuedAt: record.issuedAt, expiresAt: record.expiresAt, syntheticOnly: environment === 'synthetic-staging', disclosure: r.disclosure } }) };
    },

    async redeem(session: ConsumerSession, raw: unknown): Promise<{ ok: true; redeemed: ProductActionRedeemed } | Refused> {
      const r = release();
      if (!r) return refuse('commerce_disabled');
      if (!sessionFresh(session)) return refuse('session_stale');
      const parsed = productActionRedemptionRequest.safeParse(raw);
      if (!parsed.success) return refuse('request_invalid');
      const record = await ports.actions.get(parsed.data.actionId);
      if (!record || record.actionId !== parsed.data.actionId || record.environment !== environment) return refuse('action_not_found');
      if (record.accountId !== session.accountId) return refuse('other_account');
      if (record.sessionId !== session.sessionId) return refuse('session_mismatch');
      if (ports.clock.now().getTime() >= Date.parse(record.expiresAt)) return refuse('action_expired');
      if (record.redeemedAt !== null) return refuse('action_used');
      // Everything that held at issue is checked again: a link revoked or a product changed since then wins.
      const admitted = await admission(session.accountId, r);
      if (!admitted.ok) return refuse(admitted.refused);
      if (admitted.connectionId !== record.connectionId) return refuse('patient_link_not_found');
      const offer = await currentOffer(record.binding, r);
      if (!offer.ok) return offer;
      if (offer.destinationUrl !== record.destinationUrl) return refuse('destination_unverified');
      if (!(await ports.actions.spend(record.actionId, nowIso()))) return refuse('action_used');
      return { ok: true, redeemed: productActionRedeemed.parse({ contractVersion: FULLSCRIPT_CONSUMER_ACTION, environment, provider: 'fullscript',
        data: { actionId: record.actionId, binding: record.binding, destinationUrl: record.destinationUrl, expiresAt: record.expiresAt,
          syntheticOnly: environment === 'synthetic-staging' } }) };
    },
  };
}

/** What a route would construct. There is no release parameter, on purpose. */
export function consumerPurchaseCandidate(ports: ConsumerPurchasePorts, environment: CatalogEnvironment) {
  return createConsumerPurchaseCandidate(ports, environment, CONSUMER_PURCHASE_RELEASES);
}

/**
 * The consumer-audience catalog read for one product, over the real reader. The reader already withholds
 * a product's offers from consumers unless it is open, unrestricted, labelled in the same release and has
 * exactly one destination, so a refusal from it is not explained further here; the offer coverage audit
 * says why. Bounded: a catalog larger than `maxPages` pages refuses rather than reading without end.
 */
export function consumerCatalogFromReader(reader: AwsGovernedCatalogReader, maxPages = 20): ConsumerPurchasePorts['catalog'] {
  return {
    async current(productStableId) {
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const result = await reader.listProducts({ limit: 100, audience: 'consumer', ...(cursor ? { cursor } : {}) });
        const product = result.products.find(p => p.stableId === productStableId);
        if (product) return { product, offers: result.commercial.offers.filter(o => o.productStableId === productStableId) };
        if (!result.nextCursor) return null;
        cursor = result.nextCursor;
      }
      return null;
    },
  };
}
