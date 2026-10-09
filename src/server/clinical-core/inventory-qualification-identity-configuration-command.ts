import { basename, dirname, resolve } from 'node:path';
import { inventoryBoundedFile, inventoryCanonical, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { inventoryIdentityReader, observeInventoryIdentityConfiguration } from './inventory-qualification-identity-dependency';
import type { InventoryServiceRead } from './inventory-qualification-service-observer';
import type { InventoryQualificationTarget } from './inventory-qualification-target';

export async function runInventoryIdentityConfigurationCommand(args: string[], transport: InventoryServiceRead = inventoryIdentityReader()) {
  if (args.length !== 2 || args[0] !== '--observe-configuration' || !args[1] || args[1].startsWith('--'))
    return inventoryRefuse('identity_configuration_argument_refused');
  const path = resolve(args[1]), bytes = inventoryBoundedFile(dirname(path), [basename(path)], 16384);
  let input: InventoryQualificationTarget['identity'];
  try { input = JSON.parse(bytes.toString('utf8')); } catch { return inventoryRefuse('identity_configuration_json_refused'); }
  const report = await observeInventoryIdentityConfiguration(input, transport);
  // Re-read the original bytes; a changed input must not become an observation
  // bound to a different configuration. No report contains user contact data.
  if (inventorySha(inventoryBoundedFile(dirname(path), [basename(path)], 16384)) !== inventorySha(bytes))
    return inventoryRefuse('identity_configuration_input_changed');
  return { ...report, bindingSha256: inventorySha(inventoryCanonical(input)), inputSha256: inventorySha(bytes) };
}
