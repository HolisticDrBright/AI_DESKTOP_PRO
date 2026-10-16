import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNCONVERTED_CLINIC_FAMILIES } from '../clinic-authority-families';

/**
 * Every server source that reads the legacy immutable Cognito claims (`custom:person_id`, `custom:organization_id`), and
 * what it means for a practitioner approved by clinic membership, who has neither claim. A new reader fails this test
 * until it is classified here. The classification is the inventory the decision contract asks for
 * (docs/workforce-membership-authority-decision-2026-10-15.md, "Immediate engineering sequence", step 1).
 */
type Classification =
  /** Has a `database_current` path that ignores the claims; the legacy path is unchanged until activation. */
  | 'current_membership_mode'
  /** Names the claims only to say they are ignored. */
  | 'ignores_claims'
  /** Refuses a token that carries them (the applicant API: an applicant must have no clinical claims). */
  | 'refuses_claims'
  /** The BLOCKED pre-token candidate that would mint them from a current membership; no trigger uses it. */
  | 'mints_claims_blocked'
  /** Still requires both claims: an account without them (every newly approved practitioner) is refused, so it fails
   * closed, and under `database_current` the Desktop refuses its caller family before any request. */
  | `claim_only_workforce:${keyof typeof UNCONVERTED_CLINIC_FAMILIES | 'governed_catalog'}`
  /** The consumer pool: a separate trust domain, not changed as a shortcut. */
  | 'consumer_domain'
  /** Qualification, acceptance and fixture tooling: designated fictional subjects only, never a request path. */
  | 'qualification_tooling'
  /** Compares exported legacy claims with current rows, read-only; the claims are data to it, never authority. */
  | 'reconciliation_read_only';

const CLASSIFIED: Record<string, Classification> = {
  'src/server/clinical-core/aws-identity-api.ts': 'current_membership_mode',
  'src/server/clinical-core/aws-production-clinical-api.ts': 'current_membership_mode',
  'src/server/clinical-core/aws-telehealth-requests.ts': 'current_membership_mode',
  'src/server/clinical-core/current-membership-workforce.ts': 'ignores_claims',
  'src/server/clinical-core/aws-workforce-applications-api.ts': 'refuses_claims',
  'src/server/clinical-core/aws-workforce-token-binding.ts': 'mints_claims_blocked',
  'src/server/clinical-core/privacy-operations-api.ts': 'claim_only_workforce:privacy_operations',
  'src/server/clinical-core/recording-authority-api.ts': 'claim_only_workforce:encounter_recording',
  'src/server/clinical-core/aws-governed-catalog-api.ts': 'claim_only_workforce:governed_catalog',
  'src/server/clinical-core/aws-ask-alp-api.ts': 'consumer_domain',
  'src/server/clinical-core/aws-ask-alp-private-caller.ts': 'consumer_domain',
  'src/server/clinical-core/aws-consumer-account-lambda.ts': 'consumer_domain',
  'src/server/clinical-core/aws-consumer-account.ts': 'consumer_domain',
  'src/server/clinical-core/aws-daily-guidance-api.ts': 'consumer_domain',
  'src/server/clinical-core/aws-lab-analysis-api.ts': 'consumer_domain',
  'src/server/clinical-core/owned-consumer-api.ts': 'consumer_domain',
  'src/server/clinical-core/owned-lab-api.ts': 'consumer_domain',
  'src/server/clinical-core/inventory-fixture-token.ts': 'qualification_tooling',
  'src/server/clinical-core/inventory-qualification-fixtures-cli.ts': 'qualification_tooling',
  'src/server/clinical-core/inventory-qualification-fixtures.ts': 'qualification_tooling',
  'src/server/clinical-core/inventory-qualification-identity-dependency.ts': 'qualification_tooling',
  'src/server/clinical-core/lab-delivery-acceptance.ts': 'qualification_tooling',
  'src/server/clinical-core/owned-consumer-records-acceptance.ts': 'qualification_tooling',
  'src/server/clinical-core/security-qualification.ts': 'qualification_tooling',
  'src/server/fullscript/qualification-deployment-resources.ts': 'qualification_tooling',
  'src/server/fullscript/qualification-observer.ts': 'qualification_tooling',
  'src/server/programs/program-media-host-authority.ts': 'qualification_tooling',
  'src/server/clinical-core/workforce-account-reconciliation.ts': 'reconciliation_read_only',
};

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('legacy workforce claim readers', () => {
  it('classifies every server source that reads custom:person_id or custom:organization_id', () => {
    const readers = sources('src/server')
      .filter(path => /custom:(person_id|organization_id)/.test(readFileSync(path, 'utf8')))
      .map(path => path.replaceAll('\\', '/'))
      .sort();
    expect(readers).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it('each classification holds in the source', () => {
    for (const [path, decision] of Object.entries(CLASSIFIED)) {
      const source = readFileSync(path, 'utf8');
      if (decision === 'current_membership_mode') expect(source, path).toMatch(/database_current/);
      // Named in prose only: no code reads either claim.
      if (decision === 'ignores_claims') expect(source.replace(/^\s*(\*|\/\/).*$/gm, ''), path).not.toMatch(/custom:(person_id|organization_id)/);
      if (decision === 'refuses_claims') expect(source, path).toMatch(/claim\('custom:person_id'\) \|\| claim\('custom:organization_id'\)/);
      if (decision === 'mints_claims_blocked') expect(source, path).toMatch(/Source-only candidate/);
      if (decision.startsWith('claim_only_workforce:')) {
        const family = decision.slice('claim_only_workforce:'.length);
        if (family !== 'governed_catalog') expect(Object.keys(UNCONVERTED_CLINIC_FAMILIES), path).toContain(family);
        // Requires the claim to be a UUID: an approved practitioner without legacy claims is refused, not admitted.
        expect(source, path).toMatch(/UUID\.test\([^)]*custom:person_id|custom:person_id[^\n]*UUID|requireUuid|uuidClaim|person_id.*\.test\(/);
      }
      if (decision === 'consumer_domain') expect(source, path).toMatch(/consumer/i);
      if (decision === 'reconciliation_read_only') {
        expect(source, path).toMatch(/set transaction read only/);
        expect(source, path).not.toMatch(/\b(insert into|update clinical|delete from)\b/i);
      }
    }
  });
});
