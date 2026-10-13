/**
 * Products held out of consumer supplement matching and purchase, by exact stable ID, until a reviewed
 * product-type release supersedes this list. Each is catalogued as an open, orderable supplement but is not
 * one: a glucose monitor, a toothpaste and a household cleaning product. Nothing is matched by name; the
 * workforce still reads all three with their true status. Brandon decided on 2026-10-13 that they stay in the
 * catalog under their real types (NutriSense as a device for people with blood sugar issues); the type
 * correction itself is a reviewed catalog release, not this list.
 */
export type ConsumerQuarantineReason = "non_supplement_device" | "non_supplement_personal_care" | "non_supplement_household";
export const CONSUMER_SUPPLEMENT_QUARANTINE: Readonly<Record<string, ConsumerQuarantineReason>> = Object.freeze({
  prd_aff_nutrisense_cgm_090: "non_supplement_device",
  prd_aff_super_teeth_super_teeth_089: "non_supplement_personal_care",
  prd_aff_branch_basics_branch_basics_088: "non_supplement_household",
});
export const consumerQuarantineReason = (productStableId: string): ConsumerQuarantineReason | null =>
  Object.hasOwn(CONSUMER_SUPPLEMENT_QUARANTINE, productStableId) ? CONSUMER_SUPPLEMENT_QUARANTINE[productStableId]! : null;
