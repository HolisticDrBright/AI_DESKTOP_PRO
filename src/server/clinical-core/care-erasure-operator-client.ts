if (typeof window !== 'undefined') throw new Error('care-erasure-operator-client is server-only');
import type { RdsDataCommandClient } from './rds-data-database';

const phases: Record<string, string> = { BeginTransactionCommand: 'begin', ExecuteStatementCommand: 'statement',
  CommitTransactionCommand: 'commit', RollbackTransactionCommand: 'rollback' };
const reasons: Record<string, string> = { DatabaseResumingException: 'database_resuming', DatabaseUnavailableException: 'database_unavailable',
  AccessDeniedException: 'access_denied', ExpiredTokenException: 'token_expired', CredentialsProviderError: 'credentials_unavailable',
  TimeoutError: 'timeout', AbortError: 'aborted', TransactionNotFoundException: 'transaction_missing',
  StatementTimeoutException: 'statement_timeout', ServiceUnavailableError: 'service_unavailable' };
/** Machine diagnostics only: no message, SQL, parameters, credential, body or
 * stack is retained. This wrapper never retries or changes a transaction. */
export function createCareErasureOperatorClient(sdk: RdsDataCommandClient) {
  let diagnostic: string | undefined;
  return {
    failure: () => diagnostic,
    client: { async send(command: unknown): Promise<Record<string, unknown>> {
      const name = command !== null && typeof command === 'object' ? command.constructor.name : '';
      const phase = Object.hasOwn(phases, name) ? phases[name] : 'unknown';
      try {
        const answer = await sdk.send(command);
        // A successful resume/statement resolves its previous failure. Cleanup
        // cannot replace or clear the failure that caused the rollback.
        if (phase !== 'rollback') diagnostic = undefined;
        return answer;
      } catch (error) {
        if (phase !== 'rollback' || diagnostic === undefined) {
          const value = error !== null && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : {};
          const reason = typeof value.name === 'string' && Object.hasOwn(reasons, value.name) ? reasons[value.name]
            : value.code === 'ECONNRESET' ? 'connection_reset' : value.code === 'ETIMEDOUT' ? 'timeout' : 'unknown';
          diagnostic = `${phase}_${reason}`;
        }
        throw error;
      }
    } } satisfies RdsDataCommandClient,
  };
}
