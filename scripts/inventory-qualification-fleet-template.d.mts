import type { InventoryFleetSpec } from './inventory-qualification-fleet-specs.mjs';
export function inventoryFleetTemplate(parent: unknown, sourceCommit: string, spec: InventoryFleetSpec): {
  template: unknown; bindings: Array<{ logicalId: string; file: string; handler: string; kind: 'api' | 'worker'; activationKey: string;
    bucketParameter: string; keyParameter: string; versionParameter: string }> };
