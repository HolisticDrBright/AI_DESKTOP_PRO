import {
  noteTemplateAdminRequest, noteDraftingContextRequest,
  parseNoteTemplateAdminResponse, parseNoteDraftingContextResponse,
  type NoteTemplateAdminResponse, type NoteDraftingContextResponse,
} from '../../contracts/noteTemplates';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import type { ClinicalRequestContext } from './aws-identity-consent';

/**
 * The practice's note templates and house style.
 *
 * Nothing here decides anything. Whether a section list is drafteable, whether a style is a
 * closed set of choices, and whether a published version may be touched are all settled in
 * SQL, in the same transaction as the write.
 *
 * `digest_stale` is named rather than left as a generic conflict because it is the one refusal a
 * screen can act on by itself, by re-reading the draft and asking the author to look again.
 */
export type NoteTemplateCategory = 'request_invalid' | 'identity_refused' | 'digest_stale'
  | 'operation_refused' | 'service_unavailable';
export class NoteTemplateError extends Error {
  constructor(readonly category: NoteTemplateCategory) { super(category); this.name = 'NoteTemplateError'; }
}
const rejection = (error: unknown): NoteTemplateCategory => {
  if (!(error instanceof ClinicalCoreDatabaseRejection)) return 'service_unavailable';
  switch (error.category) {
    // A stale digest is the only conflict this domain's SQL raises, and it is the one refusal a
    // screen can act on by itself: re-read the draft and ask the author to look again.
    case 'conflict': return 'digest_stale';
    case 'request_invalid': return 'request_invalid';
    case 'operation_refused': return 'operation_refused';
    default: return 'identity_refused';
  }
};

function templateCall<Request, Response>(input: {
  database: ClinicalCoreDatabase; routine: string;
  parse: (body: unknown) => { success: true; data: Request } | { success: false };
  bind: (request: Request, raw: unknown) => Response;
}) {
  return async (context: ClinicalRequestContext, body: unknown): Promise<Response> => {
    if (context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') {
      throw new NoteTemplateError('identity_refused');
    }
    // A template is practice configuration a practitioner owns. A patient session has no
    // business reading or writing one.
    if (context.identityPool !== 'workforce') throw new NoteTemplateError('identity_refused');
    const parsed = input.parse(body);
    if (!parsed.success) throw new NoteTemplateError('request_invalid');
    try {
      return await input.database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
          { kind: 'uuid', value: context.actorPersonId }, { kind: 'uuid', value: context.organizationId },
          context.identityPool, context.identitySubject, context.purpose, context.environment,
          context.dataClassification,
        ]);
        const result = await tx.query<{ data: unknown }>(`select ${input.routine}($1::jsonb) as data`,
          [JSON.stringify(parsed.data)]);
        const raw = result.rows[0]?.data;
        return input.bind(parsed.data, typeof raw === 'string' ? JSON.parse(raw) : raw);
      });
    } catch (error) { throw new NoteTemplateError(rejection(error)); }
  };
}

export const createNoteTemplateAdmin = (database: ClinicalCoreDatabase) =>
  templateCall<Parameters<typeof parseNoteTemplateAdminResponse>[0], NoteTemplateAdminResponse>({
    database, routine: 'clinical_core.note_template_admin',
    parse: body => noteTemplateAdminRequest.safeParse(body), bind: parseNoteTemplateAdminResponse,
  });
export const createNoteDraftingContext = (database: ClinicalCoreDatabase) =>
  templateCall<Parameters<typeof parseNoteDraftingContextResponse>[0], NoteDraftingContextResponse>({
    database, routine: 'clinical_core.note_drafting_context',
    parse: body => noteDraftingContextRequest.safeParse(body), bind: parseNoteDraftingContextResponse,
  });
