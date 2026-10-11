export type ClinicRowWitness = {
  contract: 'clinic-historical-row-witness/1'; evidenceLayer: 'row_witness_primitive_only'; sourceOnly: true;
  observedMigrationCount: 112 | 116; historicalTableCount: 217; historicalRowCount: number;
  historicalDataSha256: string; historicalReceiptsSha256: string; newRows: 0;
  schemaAdmissionProven: false; operatorAcceptance: false; custodyProven: false; managedRoleSemanticsVerified: false;
  phiAllowed: false; activation: 'blocked';
};
export function readClinicHistoricalRowWitness(tx: { query: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  artifact: unknown, sourceReceipt: unknown): Promise<ClinicRowWitness>;
export function assertClinicHistoricalRowsPreserved(before: unknown, after: unknown): void;
