export type ClinicPreservingTransition = {
  preservation: { historicalTableNames: string[]; ledgerTable: string; newTableNames: string[] };
  transitions: { fromCount: number; toCount: number; file: string; sqlSha256: string; newTableNames: string[];
    changedObjects: { name: string; beforeSha256: string; afterSha256: string }[]; addedObjects: { name: string; digest: string }[] }[];
};
export const CLINIC_NATIVE_SOURCE_RECEIPT_SHA256: string;
export function buildClinicPreservingTransition(artifact: unknown, receipt: unknown): ClinicPreservingTransition;
export function assertClinicPreservingTransition(value: unknown, artifact: unknown, receipt: unknown): unknown;
