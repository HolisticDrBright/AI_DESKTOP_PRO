import { z } from 'zod';

/** Personal copies are user-held history, not a newly verified food analysis or
 * current clinical advice. Kept byte-identical in V2 and Desktop. */
const value = z.number().finite().nonnegative().max(100_000_000);
const text = z.string().max(2000);
const time = z.string().datetime({ offset: true });
export const mealNutrientKeys = ['calories','protein_g','carbs_g','fat_g','fiber_g','sugar_g','sodium_mg'] as const;
const nutrients = z.object({ calories:value, protein_g:value, carbs_g:value, fat_g:value, fiber_g:value, sugar_g:value, sodium_mg:value }).strict();
const item = nutrients.extend({
  id:z.string().min(1).max(180), name:z.string().min(1).max(200),
  catalogFoodId:z.string().regex(/^(usda|off):[A-Za-z0-9._-]{1,64}$/),
  portionQty:z.number().finite().positive().max(10_000), portionUnit:z.string().min(1).max(80),
  grams:z.number().finite().positive().max(100_000_000).nullable(),
  source:z.enum(['usda_fdc_foundation','usda_fdc_sr_legacy','usda_fdc_branded','open_food_facts']).nullable(),
  tags:z.array(z.string().min(1).max(100)).max(30),
}).strict();
const compliance = z.object({score:z.number().finite().min(0).max(100),violations:z.array(text).max(30),cautions:z.array(text).max(30)}).strict();
export const personalMealBackupSchema = nutrients.extend({
  id:z.string().uuid(), meal_time:time, meal_type:z.enum(['breakfast','lunch','dinner','snack']), notes:text,
  glycemic_load_estimate:z.null(), inflammatory_load_estimate:z.null(), food_quality_score:z.null(), tags_json:z.null(),
  details:z.object({
    version:z.literal('personal-meal/1'), sourceStatus:z.literal('consumer_copy_unverified'),
    adviceStatus:z.literal('historical_not_current_guidance'),
    items:z.array(item).min(1).max(50),
    compliance:z.object({AIP:compliance.optional(),LOW_FODMAP:compliance.optional(),KETO:compliance.optional(),LOW_HISTAMINE:compliance.optional()}).strict(),
    suggestions:z.array(text).max(40),
  }).strict(),
}).strict().superRefine((meal,ctx)=>{
  const ids = new Set<string>();
  for(const row of meal.details.items){
    if(ids.has(row.id))ctx.addIssue({code:'custom',message:'duplicate_food_item'});
    ids.add(row.id);
    if(row.source!==null && (row.catalogFoodId.startsWith('off:') !== (row.source==='open_food_facts')))
      ctx.addIssue({code:'custom',message:'food_source_mismatch'});
  }
  for(const key of mealNutrientKeys){
    const sum=meal.details.items.reduce((total,row)=>total+row[key],0);
    if(Math.abs(sum-meal[key])>1e-8*Math.max(1,sum))ctx.addIssue({code:'custom',message:'meal_totals_mismatch'});
  }
  // Reserve space for PostgreSQL JSONB spacing within its unchanged 16 KiB limit.
  if(new TextEncoder().encode(JSON.stringify(meal)).length>12_000)ctx.addIssue({code:'custom',message:'meal_backup_too_large'});
});
export type PersonalMealBackup = z.infer<typeof personalMealBackupSchema>;
