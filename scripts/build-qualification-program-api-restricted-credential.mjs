import { readFileSync, writeFileSync } from 'node:fs';

const parent = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-program-api-successor.json', 'utf8'));
if (parent.Metadata?.ClinicalCore?.ContractVersion !== 'qualification-program-api-candidate/2'
  || parent.Parameters?.DatabaseSecretArn?.AllowedPattern !== '^arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-[A-Za-z0-9-]+$'
  || parent.Metadata.ClinicalCore.PhiAllowed !== false || parent.Metadata.ClinicalCore.Activation !== 'blocked')
  throw new Error('restricted_credential_parent_refused');

const candidate = structuredClone(parent);
candidate.Metadata.ClinicalCore.ContractVersion = 'qualification-program-api-candidate/3';
candidate.Metadata.ClinicalCore.SourceTemplate = 'infra/aws-clinical-core/qualification-program-api-successor.json';
candidate.Metadata.ClinicalCore.CredentialBoundary = 'BLOCKED: separate NOINHERIT login and program-only API role; no master credential or global clinical API membership; verify role and secret before change-set execution';
candidate.Metadata.ClinicalCore.DeploymentGate = 'BLOCKED: requires separate credential provisioning, exact role/secret audit, preserving SQL review and hosted refusal tests';
candidate.Parameters.DatabaseSecretArn.AllowedPattern =
  '^arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-program-api-db-[A-Za-z0-9-]+$';
candidate.Description = 'BLOCKED fictional-only program API with dedicated restricted database credential; PHI and production programs off.';

const output = 'infra/aws-clinical-core/qualification-program-api-restricted-credential.json';
const rendered = `${JSON.stringify(candidate, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8').replaceAll('\r\n', '\n') !== rendered) throw new Error('restricted_credential_candidate_drift');
} else writeFileSync(output, rendered);
