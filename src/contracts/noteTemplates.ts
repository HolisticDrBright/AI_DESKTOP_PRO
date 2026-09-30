import { z } from 'zod';

/**
 * The practitioner's own note template, and the house style a draft is written in.
 *
 * Two rules live in these shapes and no screen may soften either.
 *
 * A style is a set of enumerated choices. It has no free-text field at all, because a style is
 * given to a model and a sentence there is an instruction. Per-section guidance is free text —
 * that is where the value is — but it is bounded, it is scoped to one section, and the pinned
 * drafting boundary states that the boundary wins over anything the template asks for.
 *
 * Publishing carries the digest the author was shown. A template edited between reading it and
 * publishing it is a different template, and the clinic refuses the stale digest rather than
 * publishing something nobody looked at.
 */
export const NOTE_TEMPLATE_ACK = 'note-templates/1' as const;
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const noteTemplateNoteType = z.enum(['soap', 'adime', 'narrative', 'follow_up', 'patient_instructions']);
export type NoteTemplateNoteType = z.infer<typeof noteTemplateNoteType>;
export const noteTemplateStatus = z.enum(['active', 'archived']);
export const noteTemplateVersionStatus = z.enum(['draft', 'published', 'retired']);
/** Eight is the ceiling the proposed-note contract already enforces; a ninth could never be filled. */
export const noteTemplateSection = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,7}$/),
  label: z.string().trim().min(1).max(80),
  guidance: z.string().trim().min(1).max(400).nullish(),
}).strict();
export type NoteTemplateSection = z.infer<typeof noteTemplateSection>;
export const noteTemplateSections = z.array(noteTemplateSection).min(1).max(8)
  .refine(sections => new Set(sections.map(s => s.key)).size === sections.length, 'section_keys_must_be_distinct');

/** Every field a closed set. There is nowhere in here to write a sentence. */
export const practiceNoteStyle = z.object({
  verbosity: z.enum(['terse', 'standard', 'detailed']),
  person: z.enum(['third', 'first']),
  tense: z.enum(['past', 'present']),
  bullets: z.boolean(),
  quotePatientWords: z.boolean(),
  headingCase: z.enum(['title', 'upper', 'sentence']),
  /** Prior-chart context. Default `none`; anything wider is a much larger disclosure. */
  contextBreadth: z.enum(['none', 'last_note', 'problem_list']),
}).strict();
export type PracticeNoteStyle = z.infer<typeof practiceNoteStyle>;
export const DEFAULT_PRACTICE_NOTE_STYLE: PracticeNoteStyle = {
  verbosity: 'standard', person: 'third', tense: 'past', bullets: false,
  quotePatientWords: true, headingCase: 'title', contextBreadth: 'none',
};

export const noteTemplateAdminRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('read'), templateId: uuid }).strict(),
  z.object({
    action: z.literal('save_draft'), noteType: noteTemplateNoteType,
    name: z.string().trim().min(1).max(120), sections: noteTemplateSections,
  }).strict(),
  // The digest the author was shown. A stale one is refused, never published.
  z.object({ action: z.literal('publish'), templateId: uuid, contentSha256: hash }).strict(),
  z.object({ action: z.literal('archive'), templateId: uuid }).strict(),
  z.object({ action: z.literal('style_read') }).strict(),
  z.object({ action: z.literal('style_publish'), style: practiceNoteStyle }).strict(),
]);
export type NoteTemplateAdminRequest = z.infer<typeof noteTemplateAdminRequest>;

const styleRow = z.object({ version: z.number().int().positive(), style: practiceNoteStyle, contentSha256: hash }).strict();
export const noteTemplateAdminResponse = z.union([
  z.object({
    action: z.literal('list'), templates: z.array(z.object({
      templateId: uuid, noteType: noteTemplateNoteType, name: z.string(), status: noteTemplateStatus,
      publishedVersion: z.number().int().positive().nullable(),
      draftVersion: z.number().int().positive().nullable(), updatedAt: z.string(),
    }).strict()).max(50),
  }).strict(),
  z.object({
    action: z.literal('read'), templateId: uuid, noteType: noteTemplateNoteType, name: z.string(),
    status: noteTemplateStatus, versions: z.array(z.object({
      version: z.number().int().positive(), status: noteTemplateVersionStatus,
      sections: noteTemplateSections, contentSha256: hash, publishedAt: z.string().nullable(),
    }).strict()).max(200),
  }).strict(),
  z.object({
    action: z.literal('save_draft'), templateId: uuid, version: z.number().int().positive(),
    status: z.literal('draft'), contentSha256: hash,
  }).strict(),
  z.object({
    action: z.literal('publish'), templateId: uuid, version: z.number().int().positive(),
    status: z.literal('published'), contentSha256: hash,
  }).strict(),
  z.object({ action: z.literal('archive'), templateId: uuid, status: z.literal('archived') }).strict(),
  z.object({ action: z.literal('style_read'), style: styleRow.nullable() }).strict(),
  z.object({ action: z.literal('style_publish'), version: z.number().int().positive(), contentSha256: hash }).strict(),
]);
export type NoteTemplateAdminResponse = z.infer<typeof noteTemplateAdminResponse>;

export const noteDraftingContextRequest = z.object({ action: z.literal('resolve'), noteType: noteTemplateNoteType }).strict();
export type NoteDraftingContextRequest = z.infer<typeof noteDraftingContextRequest>;
/**
 * `context.available` is false and carries a reason whenever a breadth wider than `none` was
 * asked for and could not be supplied. An empty context with no reason would read as
 * "searched and found nothing", which is a different and untrue statement.
 */
export const noteDraftingContextResponse = z.object({
  action: z.literal('resolve'), noteType: noteTemplateNoteType,
  template: z.object({
    templateId: uuid, name: z.string(), version: z.number().int().positive(),
    sections: noteTemplateSections, contentSha256: hash,
  }).strict().nullable(),
  style: styleRow.nullable(),
  context: z.object({
    breadth: practiceNoteStyle.shape.contextBreadth, available: z.boolean(),
    withheldReason: z.enum(['prior_chart_not_available_in_this_family']).nullable(),
  }).strict(),
}).strict();
export type NoteDraftingContextResponse = z.infer<typeof noteDraftingContextResponse>;

const bind = <Request extends { action: string }, Response extends { action: string }>(
  schema: z.ZodType<Response>, request: Request, raw: unknown,
): Response => {
  const parsed = schema.parse(raw);
  if (parsed.action !== request.action) throw new Error('response_action_mismatch');
  return parsed;
};
export const parseNoteTemplateAdminResponse = (request: NoteTemplateAdminRequest, raw: unknown) =>
  bind(noteTemplateAdminResponse, request, raw);
export const parseNoteDraftingContextResponse = (request: NoteDraftingContextRequest, raw: unknown) =>
  bind(noteDraftingContextResponse, request, raw);

/** What a person is told a style choice does. Plain words, because a clinician picks these once. */
export const NOTE_STYLE_LABEL: Record<keyof PracticeNoteStyle, string> = {
  verbosity: 'Length',
  person: 'Point of view',
  tense: 'Tense',
  bullets: 'Bulleted lists',
  quotePatientWords: 'Quote the patient’s own words',
  headingCase: 'Heading capitalisation',
  contextBreadth: 'What else the draft may see',
};
export const CONTEXT_BREADTH_LABEL: Record<PracticeNoteStyle['contextBreadth'], string> = {
  none: 'This encounter’s transcript only',
  last_note: 'Also the previous note',
  problem_list: 'Also the problem list',
};
