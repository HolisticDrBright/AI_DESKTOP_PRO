if (typeof window !== 'undefined') throw new Error('rds-single-attempt-client is server-only');
import { RDSDataClient, type RDSDataClientConfig } from '@aws-sdk/client-rds-data';

/** Separate factory so actual SDK retry middleware can be tested without AWS. */
export function createSingleAttemptRdsClient(configuration: RDSDataClientConfig): RDSDataClient {
  const options = { ...configuration };
  if (options.retryStrategy !== undefined) throw new Error('rds_retry_strategy_refused');
  return new RDSDataClient({ ...options, maxAttempts: 1 });
}
