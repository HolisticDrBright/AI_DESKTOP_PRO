export const TELEHEALTH_SCHEMA_NAMES: readonly string[];
export const TELEHEALTH_SCHEMA_PROJECTION: string;
export function projectTelehealthSchema(query: (sql: string, parameters: readonly unknown[]) => Promise<{ rows: Array<{ name: string; digest: string }> }>): Promise<Array<{ name: string; digest: string }>>;
