if (typeof window !== 'undefined') throw Error('inventory qualification envelope is server-only');
import { assertInventoryQualificationBinding, type InventoryQualificationBuild } from './adopted-plan-inventory-qualification-profile';

type Environment = Record<string, string | undefined>;
type Operation = (...args: unknown[]) => unknown;
/** Binds legacy handlers that do not embed a ledger pin to the distinct 107
 * synthetic profile. This is not a substitute for their own reviews, consent,
 * identity, holds or the complete-fleet ledger observer. Parent SDK modules are
 * loaded only after target admission. Environment drift refuses cached parents. */
export function createInventoryQualificationEnvelope(environment: () => Environment, supplied: InventoryQualificationBuild,
  activationKey: string, kind: 'api' | 'worker', load: () => Promise<Operation>) {
  const build = structuredClone(supplied), captured = { ...environment() };
  let parent: Promise<Operation> | undefined;
  const validate = () => {
    const current = environment(), names = Object.keys(current);
    if (names.length !== Object.keys(captured).length || names.some(name => current[name] !== captured[name])) {
      throw Error('inventory_qualification_environment_changed');
    }
    assertInventoryQualificationBinding(current, build, activationKey);
    if (current.QUALIFICATION_EXECUTION !== 'enabled') throw Error('inventory_qualification_not_enabled');
  };
  return async (...args: unknown[]) => {
    try {
      validate();
      parent ??= load();
      const invoke = await parent;
      validate(); // Do not admit a retargeted environment after asynchronous import.
      if (typeof invoke !== 'function') throw Error('inventory_qualification_entry_missing');
      return await invoke(...args);
    } catch {
      // No raw provider error, credential, record or request payload is exposed.
      // Worker refusal must fail the job, not masquerade as successful cleanup.
      if (kind === 'worker') throw Error('inventory_qualification_unavailable');
      return { statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' }, body: '{"error":"service_unavailable"}' };
    }
  };
}
