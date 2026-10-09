import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
export const QUALIFICATION_CONSENT_LEDGER = '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b';
/** Exact immutable ordered artifact, not count or last-version substitution. */
export function qualificationConsentArtifact(artifact) {
  const entries=artifact?.manifest?.migrations;
  if(artifact?.manifest?.contract_version!=='clinical-core-migrations/1' || !Array.isArray(entries) || entries.length!==106
    || !artifact.files || entries.some((m,i)=>!/^\d{14}$/.test(m.version) || typeof artifact.files[m.file]!=='string'
      || i>0 && entries[i-1].version>=m.version))throw new Error('qualification_consent_artifact_refused');
  const rows=entries.map(m=>({version:m.version,sha256:sha(artifact.files[m.file].replace(/\r\n/g,'\n'))}));
  if(sha(rows.map(m=>`${m.version}:${m.sha256}`).join('\n'))!==QUALIFICATION_CONSENT_LEDGER)throw new Error('qualification_consent_artifact_refused');
  return rows;
}
export function assertQualificationConsentLedger(actualDatabase,records,expected) {
  if(actualDatabase!=='clinical_core_qualification' || !Array.isArray(records) || records.length!==106
    || !Array.isArray(expected) || expected.length!==106
    || sha(expected.map(m=>`${m.version}:${m.sha256}`).join('\n'))!==QUALIFICATION_CONSENT_LEDGER
    || records.some((r,i)=>r?.version!==expected[i].version || r?.sha256!==expected[i].sha256))throw new Error('qualification_consent_ledger_refused');
}
export function assertQualificationConsentFoundation(foundation) {
  const outputs=Object.fromEntries((foundation?.Outputs??[]).map(o=>[o.OutputKey,o.OutputValue]));
  if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(foundation?.StackStatus)
    || outputs.PhiAllowed!=='false' || outputs.Activation!=='blocked'
    || outputs.DatabaseName!=='clinical_core_qualification' || outputs.QualificationInfrastructure!=='prepared_no_candidates'
    || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(outputs.DatabaseClusterArn??'')
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(outputs.DatabaseSecretArn??''))throw new Error('qualification_consent_foundation_refused');
  return outputs;
}
