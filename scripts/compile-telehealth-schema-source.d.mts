export type TelehealthSchemaSource = { contract: 'telehealth-schema-source/1'; sourceOnly: true; activation: 'blocked'; phiAllowed: false; postgresVersion: string;
  installerBundleSha256: string; projectionSqlSha256: string;
  snapshots: Array<{ migrationCount: number; migrationReleaseSha256: string; assemblySha256: string; schemaSha256: string; projection: Array<{ name: string; digest: string }> }> };
export function compileTelehealthSchemaSource(): Promise<TelehealthSchemaSource>;
