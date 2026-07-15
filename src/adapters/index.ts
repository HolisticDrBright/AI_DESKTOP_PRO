/**
 * Data adapter façade.
 *
 * The UI consumes data exclusively through this `api` object, shaped the way
 * the future tRPC client will be (async, per-domain namespaces). Replacing
 * the mocks with real queries means swapping the function bodies here — the
 * components should not need to change.
 */
import {
  DEFAULT_PATIENT_ID,
  getPatient,
  getPatientSummary,
  listPatients,
} from "./patients.mock";
import { getPracticeDashboard, getRightRail } from "./practice.mock";
import { getAssistantSession } from "./assistant.mock";
import { getCommandGroups } from "./commands.mock";
import { generateDraft, type ComposerContext } from "./composer.mock";
import { buildImportPlan, type ImportSourceId } from "./imports.mock";
import type { DraftKind } from "./types";

export const api = {
  patients: {
    list: async () => listPatients(),
    get: async (id: string) => getPatient(id),
    summary: async (id: string) => getPatientSummary(id),
  },
  practice: {
    dashboard: async () => getPracticeDashboard(),
    rightRail: async () => getRightRail(),
  },
  assistant: {
    session: async () => getAssistantSession(),
  },
  commands: {
    groups: async (patientId?: string) => getCommandGroups(patientId),
  },
  composer: {
    /** MOCK draft generation. Replace with a server-side generation call. */
    generate: async (kind: DraftKind, context: ComposerContext) =>
      generateDraft(kind, context),
  },
  imports: {
    /** MOCK import planning. Replace with a real parse + match pipeline. */
    plan: async (sourceId: ImportSourceId) => buildImportPlan(sourceId),
  },
};

export { DEFAULT_PATIENT_ID };
export * from "./types";
