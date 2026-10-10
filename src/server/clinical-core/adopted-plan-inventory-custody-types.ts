import type { AdoptedInventoryUpgradeResult } from './adopted-plan-inventory-schema-upgrade';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';

export type InventoryCustodyBinding = {
  build: { sourceCommit: string; clean: boolean };
  configuration: QualificationUpgradeConfiguration;
  callerSha256: string;
};
export type InventoryCustodyStage = 'baseline' | 'rehearsal' | 'write_admitted' | 'write_reply' | 'readback_one' | 'readback_two';
export type InventoryWriterCustody = {
  verify: () => Promise<void>;
  record: (stage: InventoryCustodyStage, observation: AdoptedInventoryUpgradeResult) => Promise<void>;
  finding: () => Promise<void>;
  settle: (observation: AdoptedInventoryUpgradeResult) => Promise<{ runId: string; journalSha256: string; custodySettled: true }>;
};
export type InventoryRecoveryCustody = {
  baseline: AdoptedInventoryUpgradeResult;
  writeAdmitted: boolean;
  verify: () => Promise<void>;
  settle: (observation: AdoptedInventoryUpgradeResult) => Promise<{
    runId: string; journalSha256: string; custodySettled: true;
    originalWriteOutcome: 'unknown';
  }>;
};
export type InventoryOperatorFence = { verify: () => Promise<void> };
