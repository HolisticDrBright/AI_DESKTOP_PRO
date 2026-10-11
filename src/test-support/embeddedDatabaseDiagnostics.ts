import { createHash } from 'node:crypto';

export type EmbeddedQueryDiagnostic = Readonly<{
  event: 'embedded_database_query_failed';
  statementSha256: string;
  sqlState: string | null;
}>;

/** Test-only evidence. Never copy SQL, parameters, messages or provider details. */
export function embeddedQueryDiagnostic(sql: string, error: unknown): EmbeddedQueryDiagnostic {
  let sqlState: string | null = null;
  try {
    if (error !== null && typeof error === 'object') {
      // Do not execute exception getters while reporting the original failure.
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
        && /^[0-9A-Z]{5}$/.test(descriptor.value)) sqlState = descriptor.value;
    }
  } catch {
    // A hostile proxy or unreadable exception does not replace the query error.
  }
  return {
    event: 'embedded_database_query_failed',
    statementSha256: createHash('sha256').update(sql).digest('hex'),
    sqlState,
  };
}

/** Observe exactly one fictional query attempt; never retry or alter its result. */
export async function observeEmbeddedQuery<Result>(
  sql: string,
  execute: () => Promise<Result>,
  emit: (diagnostic: EmbeddedQueryDiagnostic) => void,
): Promise<Result> {
  try {
    return await execute();
  } catch (error) {
    try {
      emit(embeddedQueryDiagnostic(sql, error));
    } catch {
      // Logging failure cannot hide or replace the original database failure.
    }
    throw error;
  }
}
