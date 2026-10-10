import { z } from 'zod';

/**
 * A purchasable cart compiled from a published protocol.
 *
 * Two rules live in these shapes and no screen may soften either.
 *
 * A compile request names a version and cannot describe one. There is nowhere in it to put
 * lines, prices or products, because a cart compiled from what a caller sent would be a cart
 * nobody reviewed.
 *
 * An excluded line is part of the manifest and carries its reason. A product that silently
 * disappeared between the protocol and the cart is the failure this shape exists to prevent, so
 * `lines` holds every supplement the protocol named and `included` says which may be bought.
 */
export const PROTOCOL_CART_ACK = 'protocol-carts/1' as const;
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const cartExclusionReason = z.enum(['iron_requires_individual_review',
  'reproductive_requires_individual_review', 'no_purchase_destination',
  'program_step_unreleased', 'catalog_authority_unavailable']);
export type CartExclusionReason = z.infer<typeof cartExclusionReason>;
export const cartManifestStatus = z.enum(['compiled', 'superseded']);

export const cartLine = z.object({
  phaseId: z.string(), itemId: z.string(), title: z.string(),
  productId: z.string(), dose: z.string(),
  ingredientKeys: z.array(z.string()).min(1).max(40),
  purchaseUrl: z.string().max(2048).url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }).nullable(),
  included: z.boolean(), exclusionReason: cartExclusionReason.nullable(),
}).strict().superRefine((line, context) => {
  if (line.included ? line.exclusionReason !== null || line.purchaseUrl === null : line.exclusionReason === null) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'cart_line_inclusion_mismatch'});
  }
});
export type CartLine = z.infer<typeof cartLine>;

export const protocolCartRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), programId: uuid }).strict(),
  z.object({ action: z.literal('read'), manifestId: uuid }).strict(),
  // Only the version. Nothing about its contents may be supplied.
  z.object({ action: z.literal('compile'), programVersionId: uuid }).strict(),
]);
export type ProtocolCartRequest = z.infer<typeof protocolCartRequest>;

export const protocolCartResponse = z.union([
  z.object({
    action: z.literal('list'), manifests: z.array(z.object({
      manifestId: uuid, programVersionId: uuid, programVersion: z.number().int().positive(),
      status: cartManifestStatus, includedCount: z.number().int().min(0),
      excludedCount: z.number().int().min(0), contentSha256: hash, compiledAt: z.string(),
    }).strict()).max(200),
  }).strict(),
  z.object({
    action: z.literal('read'), manifestId: uuid, programVersionId: uuid,
    programVersion: z.number().int().positive(), status: cartManifestStatus,
    versionContentSha256: hash, lines: z.array(cartLine).max(400),
    includedCount: z.number().int().min(0), excludedCount: z.number().int().min(0),
    contentSha256: hash,
    // Stated by the clinic, not assumed by the screen: nothing has been sent anywhere.
    delivery: z.object({ state: z.literal('not_implemented'), detail: z.string() }).strict(),
  }).strict().superRefine((manifest, context) => {
    const included = manifest.lines.filter(line => line.included).length;
    if (manifest.includedCount !== included || manifest.excludedCount !== manifest.lines.length - included) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'cart_line_count_mismatch'});
    }
    const identities = manifest.lines.map(line => JSON.stringify([line.phaseId, line.itemId]));
    if (new Set(identities).size !== identities.length) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'cart_line_identity_duplicate'});
    }
  }),
  z.object({
    action: z.literal('compile'), manifestId: uuid, programVersion: z.number().int().positive(),
    includedCount: z.number().int().min(0), excludedCount: z.number().int().min(0),
    contentSha256: hash, replayed: z.boolean(),
  }).strict(),
]);
export type ProtocolCartResponse = z.infer<typeof protocolCartResponse>;

export const parseProtocolCartResponse = (request: ProtocolCartRequest, raw: unknown) => {
  const parsed = protocolCartResponse.parse(raw);
  if (parsed.action !== request.action) throw new Error('response_action_mismatch');
  if (request.action === 'read' && parsed.action === 'read' && parsed.manifestId !== request.manifestId) {
    throw new Error('response_manifest_mismatch');
  }
  return parsed;
};

/** Why a line is not in the cart, in the words a practitioner needs rather than a code. */
export const CART_EXCLUSION_LABEL: Record<CartExclusionReason, string> = {
  iron_requires_individual_review:
    'Contains iron — the dose depends on a ferritin a cart cannot see, so this one is yours to decide',
  reproductive_requires_individual_review:
    'Touches pregnancy, nursing or fertility — an individual decision, not a cart’s',
  no_purchase_destination: 'No approved purchase destination on this product yet',
  program_step_unreleased: 'This program step has not been released for the patient',
  catalog_authority_unavailable: 'Current catalog approval or verified ingredient evidence is missing or changed',
};
