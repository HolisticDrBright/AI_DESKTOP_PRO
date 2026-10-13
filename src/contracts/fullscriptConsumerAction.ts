import { z } from 'zod';

/**
 * Consumer Fullscript product action (fullscript-consumer-action/2). This module is a byte-identical
 * mirror between AI_DESKTOP_PRO src/contracts/ and AI_LONGEVITY_PRO_V2 expo/contracts/; both suites pin
 * the same digest, so a change on one side without the other fails both.
 *
 * One action is ONE current product, its current label and its single active offer, for one purpose,
 * issued to one account in one recent session, and it expires. The client names the exact versions the
 * person was shown and the server refuses if any of them is no longer current. The issue response carries
 * no address: the destination is returned once, by redemption, to the same account and session before
 * expiry, after the server has re-checked everything and verified that the address is the reviewed
 * offer's own Fullscript product page in the reviewed storefront and dispensary. Version 1 named a
 * product only, so a changed label or a second offer could not be detected; it is superseded, not
 * extended.
 *
 * Purchase admission (purchase-admission/1) is what the person declared: where they live and, for the
 * clinician-connected tier, the care connection they are in. A declaration is not admission; the server
 * validates it against its own records. Nothing here comes from an IP address, a device locale or a time
 * zone, and every schema is strict, so a field that would carry one is refused rather than ignored.
 */
export const FULLSCRIPT_CONSUMER_ACTION = 'fullscript-consumer-action/2' as const;
export const PURCHASE_ADMISSION = 'purchase-admission/1' as const;
/** An action is for the next step in this session, not for later. */
export const ACTION_LIFETIME_SECONDS = 600;
/** A purchase step needs a recent sign-in. */
export const PURCHASE_MAX_AUTH_AGE_SECONDS = 900;

const uuid = z.string().uuid();
const version = z.number().int().min(1).max(999_999_999);
const instant = z.string().datetime();
const environment = z.enum(['synthetic-staging', 'production-clinical']);
/** A recorded state code such as US-TX. Never a wildcard and never inferred. */
export const recordedJurisdiction = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
export const productActionId = z.string().regex(/^act_[A-Za-z0-9_-]{32}$/);

export const productActionBinding = z.object({
  productStableId: z.string().regex(/^prd_[a-z0-9][a-z0-9_-]{2,95}$/), productVersion: version,
  labelStableId: z.string().regex(/^lbl_[a-z0-9][a-z0-9_-]{2,95}$/), labelVersion: version,
  offerStableId: z.string().regex(/^off_[a-z0-9][a-z0-9_-]{2,95}$/), offerVersion: version,
}).strict();
export type ProductActionBinding = z.infer<typeof productActionBinding>;

export const productActionRequest = z.object({
  contract: z.literal(FULLSCRIPT_CONSUMER_ACTION),
  kind: z.literal('product_patient_action'),
  purpose: z.literal('supplement_purchase'),
  requestId: uuid,
  binding: productActionBinding,
}).strict();
export type ProductActionRequest = z.infer<typeof productActionRequest>;

export const productActionRedemptionRequest = z.object({
  contract: z.literal(FULLSCRIPT_CONSUMER_ACTION),
  actionId: productActionId,
}).strict();

export const purchaseAdmissionDeclaration = z.object({
  contract: z.literal(PURCHASE_ADMISSION),
  jurisdiction: recordedJurisdiction,
  practitioner: z.discriminatedUnion('relationship', [
    z.object({ relationship: z.literal('none') }).strict(),
    z.object({ relationship: z.literal('connected'), connectionId: uuid }).strict(),
  ]),
}).strict();
export type PurchaseAdmissionDeclaration = z.infer<typeof purchaseAdmissionDeclaration>;

export const admissionRefusal = z.enum([
  'admission_required', 'jurisdiction_not_supported', 'practitioner_jurisdiction_unverified',
  'practitioner_relationship_required', 'patient_link_not_found', 'patient_link_paused', 'patient_link_revoked',
  'patient_link_other_clinic',
]);
export type AdmissionRefusal = z.infer<typeof admissionRefusal>;
export const productActionRefusal = z.enum([
  'commerce_disabled', 'request_invalid', 'session_stale', 'session_mismatch', 'other_account',
  ...admissionRefusal.options,
  'product_unavailable', 'product_restricted', 'product_changed', 'label_missing', 'label_changed',
  'offer_unavailable', 'multiple_offers', 'offer_changed', 'destination_unverified',
  'request_replayed', 'action_not_found', 'action_expired', 'action_used',
]);
export type ProductActionRefusal = z.infer<typeof productActionRefusal>;
/** What a client is told. An action held by another account does not exist, as far as this caller knows. */
export function publicRefusal(reason: ProductActionRefusal): ProductActionRefusal {
  return reason === 'other_account' ? 'action_not_found' : reason;
}

export const purchaseAdmissionStatus = z.object({
  contract: z.literal(PURCHASE_ADMISSION),
  state: z.enum(['not_declared', 'admitted', 'refused']),
  jurisdiction: recordedJurisdiction.nullable(),
  practitioner: z.enum(['none', 'connected']).nullable(),
  reason: admissionRefusal.nullable(),
  recordedAt: instant.nullable(),
}).strict().superRefine((s, c) => {
  if ((s.state === 'refused') !== (s.reason !== null)) c.addIssue({ code: 'custom', message: 'admission_reason_mismatch' });
  if ((s.state === 'not_declared') !== (s.jurisdiction === null && s.practitioner === null && s.recordedAt === null))
    c.addIssue({ code: 'custom', message: 'admission_declaration_mismatch' });
});
export type PurchaseAdmissionStatus = z.infer<typeof purchaseAdmissionStatus>;

/**
 * The only address an action may carry: a product page in one Fullscript storefront, over https, with no
 * credentials, port or fragment, and no query other than one `variant`. Which storefront host and which
 * dispensary are not written here: both come from the reviewed release, and the server names the host it
 * verified alongside the address. A dispensary welcome or sign-up page is not bound to a product and is
 * refused; so is anything that could redirect onward.
 */
const reference = /^[A-Za-z0-9_-]{4,128}={0,2}$/;
const storefrontHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fullscript\.com$/;
export function fullscriptStorefrontHost(host: string): boolean {
  return typeof host === 'string' && storefrontHost.test(host);
}
export function fullscriptProductDestination(value: string, host: string): { dispensarySlug: string; productRef: string; variantRef: string | null } | null {
  if (typeof value !== 'string' || value.length > 2048 || !fullscriptStorefrontHost(host)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  // The address must already be in its one serialised form, so no encoded variant of it passes.
  if (url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.hostname !== host) return null;
  const path = /^\/s\/([a-z0-9][a-z0-9-]{1,62})\/shop\/product\/([^/]+)$/.exec(url.pathname);
  if (!path || !reference.test(path[2]!)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some(k => k !== 'variant') || keys.length > 1) return null;
  const variant = url.searchParams.get('variant');
  if (variant !== null && !reference.test(variant)) return null;
  return { dispensarySlug: path[1]!, productRef: path[2]!, variantRef: variant };
}

const header = { contractVersion: z.literal(FULLSCRIPT_CONSUMER_ACTION), environment, provider: z.literal('fullscript') };
const syntheticBoundary = (value: { environment: string; data: { syntheticOnly: boolean } }, c: { addIssue: (issue: { code: 'custom'; message: string }) => void }) => {
  if (value.environment === 'synthetic-staging' && !value.data.syntheticOnly) c.addIssue({ code: 'custom', message: 'synthetic_boundary_widened' });
  if (value.environment === 'production-clinical' && value.data.syntheticOnly) c.addIssue({ code: 'custom', message: 'synthetic_in_production' });
};
export const productActionIssued = z.object({
  ...header,
  data: z.object({
    actionId: productActionId, kind: z.literal('product_patient_action'), purpose: z.literal('supplement_purchase'),
    binding: productActionBinding, issuedAt: instant, expiresAt: instant, syntheticOnly: z.boolean(),
    disclosure: z.string().min(1).max(500),
  }).strict(),
}).strict().superRefine((value, c) => {
  syntheticBoundary(value, c);
  const lifetime = Date.parse(value.data.expiresAt) - Date.parse(value.data.issuedAt);
  if (!(lifetime > 0 && lifetime <= ACTION_LIFETIME_SECONDS * 1000)) c.addIssue({ code: 'custom', message: 'action_lifetime_invalid' });
});
export type ProductActionIssued = z.infer<typeof productActionIssued>;
export const productActionRedeemed = z.object({
  ...header,
  data: z.object({
    actionId: productActionId, binding: productActionBinding, destinationUrl: z.string().max(2048),
    destinationHost: z.string().max(253), expiresAt: instant, syntheticOnly: z.boolean(),
  }).strict(),
}).strict().superRefine((value, c) => {
  syntheticBoundary(value, c);
  if (!fullscriptProductDestination(value.data.destinationUrl, value.data.destinationHost)) c.addIssue({ code: 'custom', message: 'destination_unverified' });
});
export type ProductActionRedeemed = z.infer<typeof productActionRedeemed>;
export const productActionRefused = z.object({ ...header, refused: productActionRefusal }).strict();
