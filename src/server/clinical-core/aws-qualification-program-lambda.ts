if (typeof window !== 'undefined') throw new Error('aws-qualification-program-lambda is server-only');

import candidate from '../../../infra/aws-clinical-core/source-candidates/qualification-program-boundary.json';
import { createRdsDataQualificationProgramDatabase } from './rds-data-database';
import { requireQualificationConsumerCore } from './core-subscription-guard';
import { createQualificationProgramHandler } from './qualification-program-api';

/** Replaced by the clean-checkout build, never read from a deploy-time environment variable. */
declare const __QUALIFICATION_PROGRAM_SOURCE_COMMIT__: string;

const environment = { ...process.env };
// Exact prosrc hashes of the two proxies in qualification-program-api-login.sql.
// The source candidate test fails if either reviewed body or this binding drifts.
export const QUALIFICATION_PROGRAM_PROXY_BINDINGS = [
  { name: 'clinical_program_qualification.set_request_context', bodySha256: '23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215' },
  { name: 'clinical_program_qualification.bounded_request', bodySha256: '7f712320f522c958fb6946685de7be8a3004af9ea89acfb0a467a7bbbe0b78df' },
] as const;
export const handler = createQualificationProgramHandler(environment, {
  sourceCommit: __QUALIFICATION_PROGRAM_SOURCE_COMMIT__,
  sourceClean: true,
  migrationCount: candidate.ledger.migrationCount,
  migrationReleaseSha256: candidate.ledger.migrationReleaseSha256,
  boundaryCandidateSha256: candidate.successor.sha256,
  functions: [...candidate.functions.map(({ name, bodySha256 }) => ({ name, bodySha256 })), ...QUALIFICATION_PROGRAM_PROXY_BINDINGS],
}, {
  databaseFactory: createRdsDataQualificationProgramDatabase,
  verifyConsumerCore: authorization => requireQualificationConsumerCore(authorization, environment),
});
