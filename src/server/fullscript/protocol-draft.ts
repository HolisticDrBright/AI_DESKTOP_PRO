if (typeof window !== 'undefined') throw new Error('Fullscript protocol drafts are server-only.');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseProtocolCartResponse } from '../../contracts/protocolCarts';

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/).refine(value => value !== '0'.repeat(64));
const providerId = z.string().regex(/^[A-Za-z0-9-]{8,128}$/);
const quantity = z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/);
export const fullscriptSupplementDraftInput = z.object({
  fullscriptPatientId: providerId, practitionerId: providerId,
  idempotencyKey: z.string().regex(/^alp-cart-[a-f0-9]{64}$/),
  recommendations: z.array(z.object({
    variantId: providerId, unitsToPurchase: quantity,
    instructions: z.string().min(1).max(2000).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, context) => {
  if (new Set(value.recommendations.map(row => row.variantId)).size !== value.recommendations.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'draft_variant_duplicate' });
});
export type FullscriptSupplementDraftInput = z.infer<typeof fullscriptSupplementDraftInput>;
export class ProtocolDraftRefused extends Error {
  constructor() { super('protocol_draft_refused'); this.name = 'ProtocolDraftRefused'; }
}
const mappingSet = z.object({
  manifestId: uuid, manifestContentSha256: hash,
  // These are binding inputs, NOT evidence that this module reviewed a release.
  catalogReleaseSha256: hash, mappingReleaseSha256: hash,
  fullscriptPatientId: providerId, practitionerId: providerId,
  lines: z.array(z.object({
    phaseId: z.string().min(1).max(200), itemId: z.string().min(1).max(200),
    productId: z.string().min(1).max(200), variantId: providerId,
    unitsToPurchase: quantity,
  }).strict()).min(1).max(200),
}).strict();
const canonical = (value: unknown): string => Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
    : JSON.stringify(value);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const lineKey = (line: {phaseId: string; itemId: string}) => JSON.stringify([line.phaseId, line.itemId]);

/** Deterministic payload compiler only. A future durable delivery service MUST
 * obtain the manifest, recipient/practitioner bindings, quantities and reviewed
 * mapping/catalog releases from its own same-target authority. Request JSON,
 * names, purchase URLs or a matching digest are not that authority. This module
 * does not create, send, activate, pay for or certify a provider cart. */
export function compileFullscriptProtocolDraft(rawManifest: unknown, rawMappings: unknown) {
  try {
    const mappings = mappingSet.parse(rawMappings);
    const manifest = parseProtocolCartResponse({action: 'read', manifestId: mappings.manifestId}, rawManifest);
    if (manifest.action !== 'read' || manifest.status !== 'compiled'
      || manifest.contentSha256 !== mappings.manifestContentSha256) throw new ProtocolDraftRefused();
    const included = manifest.lines.filter(line => line.included);
    if (!included.length || included.length !== mappings.lines.length) throw new ProtocolDraftRefused();
    const byLine = new Map(mappings.lines.map(line => [lineKey(line), line]));
    if (byLine.size !== mappings.lines.length) throw new ProtocolDraftRefused();
    const recommendations = included.map(line => {
      const mapped = byLine.get(lineKey(line));
      if (!mapped || mapped.productId !== line.productId) throw new ProtocolDraftRefused();
      // No dose parsing, package estimate or variant guessing. Keep the exact
      // compiled instruction and the separately reviewed purchase quantity.
      return {variantId: mapped.variantId, unitsToPurchase: mapped.unitsToPurchase, instructions: line.dose};
    });
    const intent = {
      contract: 'fullscript-protocol-draft-intent/1', environment: 'sandbox_us',
      manifestId: manifest.manifestId, manifestContentSha256: manifest.contentSha256,
      catalogReleaseSha256: mappings.catalogReleaseSha256, mappingReleaseSha256: mappings.mappingReleaseSha256,
      fullscriptPatientId: mappings.fullscriptPatientId, practitionerId: mappings.practitionerId,
      recommendations,
    };
    const intentSha256 = digest(intent);
    const input = fullscriptSupplementDraftInput.parse({
      fullscriptPatientId: intent.fullscriptPatientId, practitionerId: intent.practitionerId,
      idempotencyKey: 'alp-cart-' + intentSha256, recommendations,
    });
    return {intentSha256, input, includedCount: recommendations.length, excludedCount: manifest.excludedCount,
      authorityVerified: false as const, providerCreated: false as const, phiAllowed: false as const};
  } catch { throw new ProtocolDraftRefused(); }
}
