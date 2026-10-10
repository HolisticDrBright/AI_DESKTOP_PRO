export type InventoryFleetSpec = { name: string; builder: string; flags?: string[]; runtime?: string;
  functions: Array<{ id: string; file: string; source: string; activation: string; kind: 'api' | 'worker'; exportName: string }> };
export const INVENTORY_FLEET_SPECS: InventoryFleetSpec[];
