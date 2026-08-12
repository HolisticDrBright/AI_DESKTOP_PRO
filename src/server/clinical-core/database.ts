if (typeof window !== "undefined") {
  throw new Error("clinical-core/database is server-only.");
}

export type ClinicalCoreQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
  rowCount?: number;
};

export interface ClinicalCoreTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<ClinicalCoreQueryResult<Row>>;
}

/**
 * Driver-neutral transaction seam. A future deployment adapter may implement
 * this with node-postgres, RDS Proxy, or another reviewed Aurora transport.
 * Clinical operations never receive a raw, non-transactional client.
 */
export interface ClinicalCoreDatabase {
  transaction<T>(work: (tx: ClinicalCoreTransaction) => Promise<T>): Promise<T>;
}

/** A database-authored refusal with all provider and SQL text removed. */
export class ClinicalCoreDatabaseRejection extends Error {
  constructor(readonly category: "identity_refused" | "operation_refused") {
    super(category);
    this.name = "ClinicalCoreDatabaseRejection";
  }
}
