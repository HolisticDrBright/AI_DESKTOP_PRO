import { z } from 'zod';
import { programPhases } from '@/contracts/programAssignments';

/**
 * Authoring and publication validation for the patient-facing program a version carries
 * (`content.consumerProgram`). The validator is the shared contract the service and the
 * consumer app both parse, so what the Studio calls valid is what an assignment would
 * compile. Admission by the deployed SQL copy of the contract is a separate, narrower
 * question answered by `pendingAdmission`: a field the contract accepts but the current
 * service does not admit is stored on save and refused at assignment, and the Studio
 * says so instead of pretending the version can reach a patient.
 *
 * Nothing here approves content. Authorship is a label, a source is a reference, a media
 * slot is an address. A dose, a claim or a purchase never originates in this module.
 */
export const consumerProgramSchema = z.object({ title: z.string().trim().min(1).max(240), phases: programPhases }).strict();
export type ConsumerProgram = z.infer<typeof consumerProgramSchema>;
export type ConsumerProgramPhase = ConsumerProgram['phases'][number];
export type ConsumerProgramItem = ConsumerProgramPhase['items'][number];

/**
 * The key sets the deployed SQL validator (`clinical_private.program_content_valid`, migration
 * 20260929120000) admits today. A test holds these equal to the migration text, so a change
 * on either side is loud. The admission candidate
 * `source-candidates/program-education-catalog-admission.sql` widens them; until Codex applies
 * it, items that use the wider fields are pending admission.
 */
export const SQL_ADMISSION_CURRENT = {
  itemKeys: ['id', 'title', 'kind', 'instructions', 'released'] as const,
  productKeys: ['id', 'ingredientKeys', 'dose', 'purchaseUrl'] as const,
} as const;
export const EDUCATION_KEYS = ['rationale', 'sources', 'media', 'authorship'] as const;

export type PendingAdmission = { education: string[]; catalog: string[] };
export function pendingAdmission(program: ConsumerProgram): PendingAdmission {
  const education: string[] = [], catalog: string[] = [];
  for (const phase of program.phases) for (const item of phase.items) {
    if (EDUCATION_KEYS.some(key => item[key] !== undefined)) education.push(item.id);
    if (item.product?.catalog !== undefined) catalog.push(item.id);
  }
  return { education, catalog };
}

export type ConsumerProgramValidation =
  | { ok: true; program: ConsumerProgram; pending: PendingAdmission; admittedByCurrentService: boolean }
  | { ok: false; issues: string[] };

const ISSUE_WORDS: Record<string, string> = {
  program_product_identity_required: 'a supplement step needs a governed product, and only a supplement step may carry one',
  program_ingredient_identity_duplicate: 'ingredient keys repeat after trimming and lower-casing',
  program_step_identity_duplicate: 'a phase or step id is used twice',
  program_purchase_destination_invalid: 'a purchase destination must be https with no credentials',
  program_reference_destination_invalid: 'a source or media address must be https with no credentials',
};
export function validateConsumerProgram(value: unknown): ConsumerProgramValidation {
  const parsed = consumerProgramSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 40).map(issue => {
      const where = issue.path.length ? issue.path.map(part => typeof part === 'number' ? `#${part + 1}` : part).join(' › ') : 'program';
      return `${where}: ${ISSUE_WORDS[issue.message] ?? issue.message}`;
    });
    return { ok: false, issues: [...new Set(issues)] };
  }
  const pending = pendingAdmission(parsed.data);
  return { ok: true, program: parsed.data, pending, admittedByCurrentService: pending.education.length === 0 && pending.catalog.length === 0 };
}

/**
 * Governed media is an address of a resource the clinic already holds under its own
 * governance. There is no upload or hosting path in this application yet, so the Studio
 * accepts a plain https address and nothing else: no credentials, no query string or
 * fragment (where tokens and identifiers travel), no private or test host. This is a
 * narrower check than the contract's, applied at authoring time only.
 */
export function governedMediaIssue(value: string): string | null {
  if (value.length > 2048) return 'the address is longer than 2048 characters';
  let url: URL;
  try { url = new URL(value); } catch { return 'not a complete https address'; }
  if (url.protocol !== 'https:') return 'must start with https://';
  if (url.username || url.password) return 'must not carry credentials';
  if (url.search || url.hash) return 'must not carry a query string or fragment; identifiers and tokens do not belong in a media address';
  if (!url.hostname.includes('.') || url.hostname.endsWith('.test') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return 'must name a public host';
  return null;
}

/** Flesch–Kincaid grade estimate, enough to say "this reads above about sixth grade" and no more.
 * Syllables are counted by vowel groups, which is the usual rough method. */
export function readingGrade(text: string): number | null {
  const words = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  if (words.length < 5) return null;
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const syllables = words.reduce((sum, word) => sum + Math.max(1, (word.replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length), 0);
  return Math.round((0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59) * 10) / 10;
}
export const PATIENT_READING_GRADE = 6;
export function readingLevelNote(text: string): string | null {
  const grade = readingGrade(text);
  if (grade === null || grade <= PATIENT_READING_GRADE + 1) return null;
  return `Reads at about grade ${grade}. Patient education aims for about grade ${PATIENT_READING_GRADE}: shorter sentences and plainer words.`;
}

export function emptyConsumerProgram(title = ''): ConsumerProgram { return { title, phases: [newPhase(1)] }; }
export function newPhase(number: number): ConsumerProgramPhase {
  return { id: `phase-${number}`, title: `Phase ${number}`, days: 7, transition: 'scheduled', items: [] };
}
export function newItem(kind: ConsumerProgramItem['kind'], number: number): ConsumerProgramItem {
  const base = { id: `${kind}-${number}`, title: '', instructions: '', released: false } as const;
  return kind === 'supplement'
    ? { ...base, kind, product: { id: '', ingredientKeys: [], dose: '', purchaseUrl: null } }
    : { ...base, kind };
}

/** What a version detail carried: `undefined` when the service does not return the key (authoring unavailable),
 * `null` when none is authored, otherwise whatever was stored, loosely shaped so the editor can show and repair it. */
export function consumerProgramFromDetail(raw: unknown): ConsumerProgram | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { title: '', phases: [] };
  const value = raw as { title?: unknown; phases?: unknown };
  return { title: typeof value.title === 'string' ? value.title : '', phases: Array.isArray(value.phases) ? value.phases as ConsumerProgramPhase[] : [] };
}
