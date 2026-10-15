if (typeof window !== 'undefined') throw new Error('aws-qualification-program-lambda is server-only');

import candidate from '../../../infra/aws-clinical-core/source-candidates/qualification-program-boundary.json';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';
import { requireQualificationConsumerCore } from './core-subscription-guard';
import { createQualificationProgramHandler } from './qualification-program-api';

/** Replaced by the clean-checkout build, never read from a deploy-time environment variable. */
declare const __QUALIFICATION_PROGRAM_SOURCE_COMMIT__: string;

const environment = { ...process.env };
export const handler = createQualificationProgramHandler(environment, {
  sourceCommit: __QUALIFICATION_PROGRAM_SOURCE_COMMIT__,
  sourceClean: true,
  migrationCount: candidate.ledger.migrationCount,
  migrationReleaseSha256: candidate.ledger.migrationReleaseSha256,
  boundaryCandidateSha256: candidate.successor.sha256,
  functions: candidate.functions.map(({ name, bodySha256 }) => ({ name, bodySha256 })),
}, {
  databaseFactory: createRdsDataClinicalCoreDatabase,
  verifyConsumerCore: authorization => requireQualificationConsumerCore(authorization, environment),
});
