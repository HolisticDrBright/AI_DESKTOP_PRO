import { z } from 'zod';

/** Patient-reported collection context is supplemental evidence, not a verified
 * assay, diagnosis or permission to activate a population reference interval. */
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>
  Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
export const specimenContextSchema=z.object({
  source:z.literal('patient_reported'),verification:z.literal('unverified'),
  recordedAt:z.string().datetime({offset:true}),
  observedOn:date,
  ageAtDraw:z.object({value:z.number().int().nonnegative(),unit:z.enum(['days','months','years'])}).strict()
    .refine(a=>a.value<=({days:46000,months:1500,years:125})[a.unit]),
  sex:z.enum(['male','female','other']).nullable(),
  assayId:z.string().trim().min(1).max(160).nullable(),
  pregnancyStatus:z.enum(['not_pregnant','pregnant','unsure','not_applicable']).nullable(),
  cyclePhase:z.enum(['menstrual','follicular','ovulatory','luteal','not_applicable']).nullable(),
  reproductiveStage:z.enum(['prepubertal','reproductive','irregular_cycles','perimenopause','menopause','pregnant','postpartum']).nullable(),
  contraception:z.enum(['none','hormonal','non_hormonal']).nullable(),
  pregnancyTrimester:z.number().int().min(1).max(3).nullable(),
}).strict().refine(c=>c.pregnancyTrimester===null||c.pregnancyStatus==='pregnant');
export type SpecimenContext=z.infer<typeof specimenContextSchema>;
export const specimenHasReproductiveContext=(c:SpecimenContext)=>
  [c.pregnancyStatus,c.cyclePhase,c.reproductiveStage,c.contraception,c.pregnancyTrimester].some(v=>v!==null);
export const labSpecimenTransferSchema=z.object({
  version:z.literal('lab-specimen-context/1'),connectionId:z.string().uuid(),
  labEventId:z.string().uuid(),labPayloadSha256:z.string().regex(/^[0-9a-f]{64}$/),
  requestId:z.string().uuid(),expectedRevision:z.number().int().min(0).max(1000000),
  consentVersion:z.number().int().positive(),
  reproductiveConsentVersion:z.number().int().positive().nullable(),
  context:specimenContextSchema,
}).strict().refine(p=>specimenHasReproductiveContext(p.context)===(p.reproductiveConsentVersion!==null));
export type LabSpecimenTransfer=z.infer<typeof labSpecimenTransferSchema>;
export const SPECIMEN_CONSENT_VERSION='lab-specimen-context-consent/1';
/** Draft copy: usable only when the server publishes an approved artifact whose
 * exact UTF-8 digest and version match. Shipping this text does not approve it. */
export const SPECIMEN_CONSENT_COPY={
  lab_specimen_context:{
    version:SPECIMEN_CONSENT_VERSION,
    text:'I authorize AI Longevity Pro to send collection context I select to my connected practice, separately from my lab results. This may include my completed age at collection, recorded sex, assay identifier and collection date. Reproductive details are excluded unless I separately authorize reproductive-health sharing and select them. My entries remain patient-reported and unverified. I can withdraw consent to stop future transfers. Withdrawal does not recall information already delivered; the practice retains its copy under its record-retention obligations. Reviewing this notice does not send any data.',
  },
  reproductive_health:{
    version:'lab-specimen-reproductive-consent/1',
    text:'I authorize sharing selected reproductive-health collection context with my connected practice: pregnancy status or trimester, cycle phase, reproductive stage and contraception status, when recorded. These are sensitive, patient-reported details, not verified diagnoses. This is separate from permission to track reproductive information in the app. I can withdraw this sharing consent to stop future transfers. Withdrawal does not recall information already delivered; the practice retains its copy under its record-retention obligations. I will review each selected record before sending.',
  },
} as const;
export const labSpecimenReceiptSchema=z.object({
  version:z.literal('lab-specimen-receipt/1'),contextId:z.string().uuid(),labEventId:z.string().uuid(),
  requestId:z.string().uuid(),revision:z.number().int().positive(),payloadSha256:z.string().regex(/^[0-9a-f]{64}$/),
  receivedAt:z.string().datetime({offset:true}),duplicate:z.boolean(),
}).strict();
export type LabSpecimenReceipt=z.infer<typeof labSpecimenReceiptSchema>;
/** Latest accepted revision, still unverified patient-reported evidence. */
export const labSpecimenRecordSchema=z.object({
  version:z.literal('lab-specimen-record/1'),contextId:z.string().uuid(),labEventId:z.string().uuid(),
  revision:z.number().int().positive(),payloadSha256:z.string().regex(/^[0-9a-f]{64}$/),
  labPayloadSha256:z.string().regex(/^[0-9a-f]{64}$/),receivedAt:z.string().datetime({offset:true}),
  context:specimenContextSchema,
}).strict();
export type LabSpecimenRecord=z.infer<typeof labSpecimenRecordSchema>;
/** Parse first to freeze caller values and make property order deterministic. */
export const specimenContent=(input:LabSpecimenTransfer)=>JSON.stringify(labSpecimenTransferSchema.parse(input));
