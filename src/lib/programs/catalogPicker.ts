import type { ProgramProductCatalogBinding } from '@/contracts/programAssignments';
import {
  catalogHold, programCatalogObservation,
  type CatalogHoldReason, type ObservedCatalogProduct, type ProgramCatalogObservation,
} from '@/contracts/programCatalogObservation';

/**
 * The governed catalog picker's decisions, with no React in them so every journey can be run as
 * a plain sequence: a read is bound to the scope it was started under (draft version, step,
 * what the step said, which Studio session), a reply that arrives for any other scope is
 * discarded, a reply for another clinic or another draft is refused, and a selection is only
 * ever made from the observation on screen, by exact stable id, carrying the release and the
 * target that observation reported. Nothing here selects on its own, substitutes a similar
 * name, or moves a binding to a newer release without the practitioner choosing it.
 */
export type CatalogPickerScope = {
  /** The draft version being edited. */
  versionId: string;
  /** The supplement step the binding belongs to. */
  stepId: string;
  /** What the step currently says about its identity; a change here invalidates an in-flight read. */
  stepRevision: string;
  /** The Studio load the editor is showing; a reload or a sign-in starts a new one. */
  session: string;
};
export type CatalogReader = (input: { versionId: string; query: string }) => Promise<unknown>;

export type CatalogUnavailableReason =
  | 'reauth_required' | 'identity_refused' | 'service_unavailable' | 'catalog_unverifiable'
  | 'catalog_target_changed' | 'cross_clinic' | 'other_draft';

export type CatalogPickerState =
  | { kind: 'idle'; note: 'none' | 'scope_changed' }
  | { kind: 'reading'; query: string }
  | { kind: 'observed'; observation: ProgramCatalogObservation }
  | { kind: 'empty'; observation: ProgramCatalogObservation }
  | { kind: 'unavailable'; reason: CatalogUnavailableReason; query: string };

export type CatalogSearchOutcome =
  | { applied: true; state: CatalogPickerState }
  | { applied: false; discarded: 'superseded' | 'scope_changed' | 'disposed' };

export type CatalogSelection =
  | { ok: true; binding: ProgramProductCatalogBinding; product: ObservedCatalogProduct }
  | { ok: false; reason: 'no_observation' | 'not_observed' | 'held'; hold?: CatalogHoldReason };

/** How an existing binding relates to what is on screen. Only `current` says the binding matches the observed release. */
export type CatalogBindingStatus =
  | { status: 'unobserved' }
  | { status: 'not_in_result'; wholeCatalog: boolean }
  | { status: 'current'; product: ObservedCatalogProduct }
  | { status: 'release_changed'; product: ObservedCatalogProduct; observedVersion: number }
  | { status: 'target_differs'; product: ObservedCatalogProduct; observedTarget: ProgramCatalogObservation['target'] };

export interface CatalogPickerController {
  state(): CatalogPickerState;
  scope(): CatalogPickerScope;
  /** The clinic the first accepted reply named; later replies must name the same one. */
  clinic(): string | null;
  rebind(scope: CatalogPickerScope): void;
  search(query: string): Promise<CatalogSearchOutcome>;
  select(stableId: string): CatalogSelection;
  bindingStatus(binding: ProgramProductCatalogBinding | undefined): CatalogBindingStatus;
  dispose(): void;
}

export function sameScope(a: CatalogPickerScope, b: CatalogPickerScope): boolean {
  return a.versionId === b.versionId && a.stepId === b.stepId && a.stepRevision === b.stepRevision && a.session === b.session;
}

export function createCatalogPickerController(input: {
  read: CatalogReader;
  scope: CatalogPickerScope;
  onChange?: (state: CatalogPickerState) => void;
}): CatalogPickerController {
  let scope = input.scope;
  let state: CatalogPickerState = { kind: 'idle', note: 'none' };
  let generation = 0;
  let disposed = false;
  let clinic: string | null = null;
  const set = (next: CatalogPickerState) => { state = next; input.onChange?.(next); };

  return {
    state: () => state,
    scope: () => scope,
    clinic: () => clinic,
    rebind(next) {
      if (sameScope(scope, next)) return;
      const sessionChanged = next.session !== scope.session;
      scope = next;
      generation += 1;
      // A new Studio session may be a different sign-in; the clinic is learned again from its first reply.
      if (sessionChanged) clinic = null;
      set({ kind: 'idle', note: 'scope_changed' });
    },
    async search(query) {
      if (disposed) return { applied: false, discarded: 'disposed' };
      generation += 1;
      const mine = generation;
      const started = scope;
      set({ kind: 'reading', query });
      let reply: unknown;
      let failure: CatalogUnavailableReason | null = null;
      try {
        reply = await input.read({ versionId: started.versionId, query });
      } catch (error) {
        failure = failureFrom(error);
      }
      if (disposed) return { applied: false, discarded: 'disposed' };
      if (!sameScope(scope, started)) return { applied: false, discarded: 'scope_changed' };
      if (mine !== generation) return { applied: false, discarded: 'superseded' };
      if (failure) { set({ kind: 'unavailable', reason: failure, query }); return { applied: true, state }; }
      const parsed = programCatalogObservation.safeParse(reply);
      if (!parsed.success) { set({ kind: 'unavailable', reason: 'catalog_unverifiable', query }); return { applied: true, state }; }
      const observation = parsed.data;
      if (observation.versionId !== started.versionId) { set({ kind: 'unavailable', reason: 'other_draft', query }); return { applied: true, state }; }
      if (clinic !== null && observation.clinic !== clinic) { set({ kind: 'unavailable', reason: 'cross_clinic', query }); return { applied: true, state }; }
      clinic = observation.clinic;
      set(observation.products.length === 0 ? { kind: 'empty', observation } : { kind: 'observed', observation });
      return { applied: true, state };
    },
    select(stableId) {
      if (state.kind !== 'observed') return { ok: false, reason: 'no_observation' };
      const product = state.observation.products.find(candidate => candidate.stableId === stableId);
      if (!product) return { ok: false, reason: 'not_observed' };
      const hold = catalogHold(product, state.observation.target);
      if (hold) return { ok: false, reason: 'held', hold };
      return { ok: true, product, binding: { stableId: product.stableId, version: product.version, target: state.observation.target } };
    },
    bindingStatus(binding) {
      if (!binding || (state.kind !== 'observed' && state.kind !== 'empty')) return { status: 'unobserved' };
      const { observation } = state;
      const product = observation.products.find(candidate => candidate.stableId === binding.stableId);
      if (!product) return { status: 'not_in_result', wholeCatalog: observation.query === '' && observation.complete };
      if (observation.target !== binding.target) return { status: 'target_differs', product, observedTarget: observation.target };
      if (product.version !== binding.version) return { status: 'release_changed', product, observedVersion: product.version };
      return { status: 'current', product };
    },
    dispose() { disposed = true; generation += 1; },
  };
}

const CATEGORIES: ReadonlySet<string> = new Set<CatalogUnavailableReason>([
  'reauth_required', 'identity_refused', 'service_unavailable', 'catalog_unverifiable', 'catalog_target_changed',
]);
function failureFrom(error: unknown): CatalogUnavailableReason {
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : {};
  if (typeof record.message === 'string' && CATEGORIES.has(record.message)) return record.message as CatalogUnavailableReason;
  if (record.code === 'unauthenticated') return 'reauth_required';
  if (record.code === 'forbidden') return 'identity_refused';
  return 'service_unavailable';
}

/** What the panel says for each way the catalog could not be observed. None of these is "no products match". */
export const CATALOG_UNAVAILABLE_WORDS: Record<CatalogUnavailableReason, string> = {
  reauth_required: 'Your session needs renewing before the catalog can be read. The draft is kept as it is.',
  identity_refused: 'The catalog service refused this session. Nothing was changed; the draft is kept as it is.',
  service_unavailable: 'The governed catalog could not be reached. This is not an empty catalog; nothing here says which products exist. The draft is kept as it is.',
  catalog_unverifiable: 'The catalog reply could not be verified against the published contract, so nothing in it can be bound. The draft is kept as it is.',
  catalog_target_changed: 'The catalog reported two different service targets during one read, so the read was refused. Search again.',
  cross_clinic: 'The reply named a different clinic from the one this editor started under, so it was refused. Sign in again and search again.',
  other_draft: 'The reply was for a different draft, so it was refused. Search again.',
};
