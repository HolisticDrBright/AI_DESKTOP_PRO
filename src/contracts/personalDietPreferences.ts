import {z} from 'zod';
/** Singleton per authenticated owner, not a globally shared record. */
export const DIET_PREFERENCES_ID='88465545-91d2-4a55-8ff1-f0e85fc255ba';
export const dietPreferencesSchema=z.object({
  id:z.literal(DIET_PREFERENCES_ID),version:z.literal('personal-diet-preferences/1'),
  activeDiets:z.array(z.enum(['AIP','LOW_FODMAP','KETO','LOW_HISTAMINE'])).max(4).refine(v=>new Set(v).size===v.length),
  allergies:z.string().max(2000),notes:z.string().max(2000),
  updatedAt:z.string().datetime({offset:true}),sourceStatus:z.literal('patient_reported_not_prescribed'),
}).strict();
export type DietPreferences=z.infer<typeof dietPreferencesSchema>;

