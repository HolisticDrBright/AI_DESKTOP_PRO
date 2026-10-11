import type { NativeSourceDatabase, TelehealthSchemaSource } from './compile-telehealth-schema-source.mjs';
export const CLINIC_SOURCE_IDENTITY: Readonly<{ count: 116; ledger: string; assembly: string; extension: string }>;
export function assertClinicSourceArtifact(value: unknown): unknown;
export function compileClinicSchemaRestrictedOwnerSource(db: NativeSourceDatabase): Promise<Omit<TelehealthSchemaSource, 'contract'> & {
  contract: 'clinic-restricted-owner-source/1'; ownerProfile: Record<string, unknown>;
  runtimeAdmission: false; managedRoleSemanticsVerified: false; providerAuthorized: false; upgradeAuthorized: false;
}>;
