export type TelehealthSchemaSource = { contract: 'telehealth-schema-source/1'; sourceOnly: true; activation: 'blocked'; phiAllowed: false; postgresVersion: string;
  installerBundleSha256: string; projectionSqlSha256: string;
  snapshots: Array<{ migrationCount: number; migrationReleaseSha256: string; assemblySha256: string; schemaSha256: string; projection: Array<{ name: string; digest: string }> }> };
export function compileTelehealthSchemaSource(): Promise<TelehealthSchemaSource>;
export type NativeSourceDatabase = {
  query(sql: string, parameters?: readonly unknown[]): Promise<{rows: Array<Record<string, unknown>>}>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(work: (transaction: NativeSourceDatabase) => Promise<T>): Promise<T>;
};
export function compileTelehealthSchemaNativeSource(db: NativeSourceDatabase): Promise<TelehealthSchemaSource>;
export function compileTelehealthSchemaRestrictedOwnerSource(db: NativeSourceDatabase): Promise<Omit<TelehealthSchemaSource,'contract'> & {
  contract:'telehealth-restricted-owner-source/1';ownerProfile:Record<string,unknown>;
}>;
