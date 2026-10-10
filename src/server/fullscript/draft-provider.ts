if (typeof window !== 'undefined') throw new Error('Fullscript provider responses are server-only.');
import {z} from 'zod';
import {FullscriptApiClient} from './client';
import {fullscriptSupplementDraftInput} from './protocol-draft';
import {DraftDeliveryRefused, parseFullscriptDraftObservation,
  type DraftDeliveryProvider, type FullscriptDraftObservation} from './draft-delivery';

const providerId = z.string().regex(/^[A-Za-z0-9-]{8,128}$/);
const metadataId = z.string().regex(/^alp-cart-[a-f0-9]{64}$/);
const empty = z.union([z.literal(''), z.null()]);
const noItems = z.array(z.never()).length(0);
const discardedText = z.string().max(100_000).nullable().optional();
const discardedLink = z.string().max(8_000).nullable().optional();

/** Wire schema from Fullscript's GET/POST treatment-plan response attributes,
 * checked 2026-10-09. Request units are strings; response units are INTEGERS.
 * Require explicit empty labs/resources and no added dose/refill directions.
 * A new/unknown field is not silently accepted as governed clinical content.
 * URLs/derived plan text are discarded, never followed or stored as receipts.
 * https://fullscript.dev/technical-reference/treatment-plans
 */
const treatmentResponse = z.object({treatment_plan: z.object({
  id: providerId,
  patient: z.object({id: providerId}).strict(),
  practitioner: z.object({id: providerId}).strict(),
  state: z.literal('draft'),
  // Documented as the date the plan was sent. Never accept an observed send.
  available_at: empty,
  source: z.literal('api').optional(),
  created_at: discardedText, updated_at: discardedText,
  invitation_url: discardedLink, checkout_url: discardedLink, practitioner_pay_url: discardedLink,
  treatment_plan_text: discardedText, personal_message: empty.optional(),
  lab_checkout_status: discardedText, patient_lab_fields_needed: noItems.optional(),
  metadata: z.object({id: metadataId}).strict(),
  lab_recommendations: noItems, resources: noItems,
  recommendations: z.array(z.object({
    variant_id: providerId, units_to_purchase: z.number().int().min(1).max(100),
    refill: z.literal(false), take_with: empty.optional(),
    dosage: z.object({
      additional_info: fullscriptSupplementDraftInput.shape.recommendations.element.shape.instructions,
      amount: empty.optional(), frequency: empty.optional(), duration: empty.optional(),
      format: empty.optional(), time_of_day: noItems.optional(),
    }).strict(),
  }).strict()).min(1).max(200),
}).strict()}).strict();

function decodeTreatmentPlan(raw: unknown): FullscriptDraftObservation {
  const p = treatmentResponse.parse(raw).treatment_plan;
  const recommendations = p.recommendations.map(r => ({variantId: r.variant_id,
    unitsToPurchase: String(r.units_to_purchase), instructions: r.dosage.additional_info}));
  // Validate duplicates, exact quantities and instruction safety using the
  // same contract as the compiled intent. No unit conversion or dose parsing.
  fullscriptSupplementDraftInput.parse({fullscriptPatientId: p.patient.id,
    practitionerId: p.practitioner.id, idempotencyKey: p.metadata.id, recommendations});
  return {contract: 'fullscript-draft-observation/1', planId: p.id, patientId: p.patient.id,
    practitionerId: p.practitioner.id, state: 'draft', metadataId: p.metadata.id,
    labs: [], recommendations};
}

/** Metadata returns an object projection, not a treatment-plan envelope. Use
 * only its ID, then independently GET that plan. Require a complete first page
 * and a unique exact key/type; incomplete or ambiguous search is not absence.
 * https://fullscript.dev/technical-reference/metadata
 */
const metadataResponse = z.object({
  metadata: z.array(z.object({id: metadataId, type: z.literal('treatment_plan'),
    data: z.object({id: providerId}).passthrough(),
  }).strict()).max(1),
  meta: z.object({current_page: z.literal(1), next_page: z.null(), prev_page: z.null(),
    total_pages: z.number().int().min(0).max(1), total_count: z.number().int().min(0).max(1),
  }).strict(),
}).strict().superRefine((v, c) => {
  if (v.meta.total_count !== v.metadata.length || (v.metadata.length > 0 && v.meta.total_pages !== 1))
    c.addIssue({code: z.ZodIssueCode.custom, message: 'metadata_incomplete'});
});

/** Source adapter for the durable ledger. No API route or production release
 * installs it. Credential/review/target bindings still belong to the runtime
 * authority, not this parser. All errors are opaque; no provider payload leaks.
 */
export function createFullscriptDraftProvider(client: FullscriptApiClient): DraftDeliveryProvider {
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch { throw new DraftDeliveryRefused(); }
  };
  return {
    create: input => guarded(async () => {
      const parsed = fullscriptSupplementDraftInput.parse(input);
      client.assertSupplementDraftCapabilities();
      const observed = decodeTreatmentPlan(await client.createSupplementDraft(parsed));
      return parseFullscriptDraftObservation(observed, parsed);
    }),
    findByMetadata: key => guarded(async () => {
      metadataId.parse(key);
      client.assertSupplementDraftReadCapabilities();
      const result = metadataResponse.parse(await client.findTreatmentPlanByMetadata(key));
      const row = result.metadata[0];
      if (!row) return []; // NOT proof of absence; ledger forbids a second POST.
      if (row.id !== key) throw new DraftDeliveryRefused();
      const observed = decodeTreatmentPlan(await client.retrieveTreatmentPlan(row.data.id));
      if (observed.planId !== row.data.id || observed.metadataId !== key) throw new DraftDeliveryRefused();
      return [observed]; // Ledger separately verifies patient/practitioner/exact lines.
    }),
  };
}
