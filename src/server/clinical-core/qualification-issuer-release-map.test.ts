import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TELEHEALTH_QUALIFICATION_RESOURCES } from '../../../scripts/telehealth-qualification-template.mjs';
import { fixtureIdentity } from './inventory-qualification-fixtures';
import {
  assertQualificationIssuerPlan, COGNITO_POOLS, issuerOf, OTHER_POOL_PINS, QUALIFICATION_API_ID, QUALIFICATION_ISSUER_RELEASE_MAP,
  QualificationIssuerPlanError, type Cite, type QualificationIssuerPlan,
} from './qualification-issuer-release-map';

/**
 * The issuer release map checked against the actual sources: every cited line, every authorizer template, every pool
 * id anywhere in source. Then its rule: one qualification run, one MFA-required workforce issuer. Source only; no AWS.
 */
const lines = new Map<string, string[]>();
const lineOf = (file: string, line: number) => {
  if (!lines.has(file)) lines.set(file, readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n'));
  return lines.get(file)![line - 1];
};
const cites = (): Cite[] => [
  ...Object.values(COGNITO_POOLS).flatMap(p => p.pins),
  ...QUALIFICATION_ISSUER_RELEASE_MAP.flatMap(e => [
    ...[e.workforce, e.consumer].flatMap(s => !s ? [] : s.kind === 'pinned' ? s.pins : s.kind === 'binding' ? (s.comparedWithAuthorizer ? [s.comparedWithAuthorizer] : []) : [s.parameter]),
    ...[e.mfaRequirement.cite, e.tokenTimes.cite, e.stackReads.cite].filter((c): c is Cite => c !== null)]),
  ...OTHER_POOL_PINS,
];
const refusal = (plan: QualificationIssuerPlan) => {
  try { assertQualificationIssuerPlan(plan); return 'admitted'; } catch (error) {
    if (error instanceof QualificationIssuerPlanError) return error.refusal;
    throw error;
  }
};
const program = ['program-api/restricted-credential', 'program-api/update-preflight'];
const telehealth = ['telehealth/qualification-template'];
const inventory = ['inventory/fixture-identities'];
const ISOLATED = { workforceIssuer: issuerOf('us-east-2_zGOVBoeGT'), workforceAudience: '1ffcdpnh0k45b3gc2hm9938ebl' };
const SHARED = { workforceIssuer: issuerOf('us-east-2_ueGlFRbNB'), workforceAudience: '4s7jgr4o8sqdq7cvo9gmq96e2h' };

describe('the release map against the source it describes', () => {
  it('every cited line holds exactly the cited text', () => {
    const wrong = cites().filter(c => !c.text || !lineOf(c.file, c.line)?.includes(c.text)).map(c => `${c.file}:${c.line}`);
    expect(wrong).toEqual([]);
  });

  it('every Cognito pool id in tracked non-test source is mapped: a new pin anywhere fails here until it is placed', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
      .filter(f => f && !f.startsWith('docs/') && !/\.test\.(ts|mjs)$/.test(f) && !/\.example\.json$/.test(f) && !f.endsWith('qualification-issuer-release-map.ts'));
    const found: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      text.replaceAll('\r\n', '\n').split('\n').forEach((line, index) => {
        if (/us-east-2_[A-Za-z0-9]{9}\b/.test(line) && !/REPLACE/.test(line)) found.push(`${file}:${index + 1}`);
      });
    }
    const mapped = new Set(cites().filter(c => /us-east-2_[A-Za-z0-9]{9}\b/.test(c.text)).map(c => `${c.file}:${c.line}`));
    expect(found.filter(at => !mapped.has(at))).toEqual([]);
    expect(found.length).toBeGreaterThanOrEqual(20);
  });

  it('each authorizer template resolves its JWT issuer from the pinned pool, and the map names that pool and client', () => {
    for (const [file, id] of [['infra/aws-clinical-core/qualification-program-api-candidate.json', 'program-api/candidate'],
      ['infra/aws-clinical-core/qualification-program-api-successor.json', 'program-api/successor'],
      ['infra/aws-clinical-core/qualification-program-api-restricted-credential.json', 'program-api/restricted-credential']] as const) {
      const template = JSON.parse(readFileSync(file, 'utf8'));
      const authorizer = template.Resources.WorkforceJwtAuthorizer.Properties.JwtConfiguration;
      expect(authorizer).toEqual({ Issuer: { 'Fn::Sub': 'https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${WorkforceUserPoolId}' }, Audience: [{ Ref: 'WorkforceUserPoolClientId' }] });
      const entry = QUALIFICATION_ISSUER_RELEASE_MAP.find(e => e.id === id)!;
      expect(entry.workforce).toMatchObject({ kind: 'pinned', pool: template.Parameters.WorkforceUserPoolId.AllowedValues[0] });
      expect(COGNITO_POOLS[template.Parameters.WorkforceUserPoolId.AllowedValues[0]]!.client).toBe(template.Parameters.WorkforceUserPoolClientId.AllowedValues[0]);
      expect(entry.consumer).toMatchObject({ kind: 'pinned', pool: template.Parameters.ConsumerUserPoolId.AllowedValues[0] });
      expect(template.Parameters.ClinicalApiId.AllowedValues).toEqual([QUALIFICATION_API_ID]);
    }
    const telehealthBase = JSON.parse(readFileSync('infra/aws-clinical-core/telehealth-requests-extension.json', 'utf8'));
    expect(telehealthBase.Resources.WorkforceAuthorizer.Properties.JwtConfiguration.Issuer).toEqual({ 'Fn::Sub': 'https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${WorkforceUserPoolId}' });
    expect(TELEHEALTH_QUALIFICATION_RESOURCES.WorkforceUserPoolId).toBe('us-east-2_zGOVBoeGT');
    expect(COGNITO_POOLS['us-east-2_zGOVBoeGT']!.client).toBe(TELEHEALTH_QUALIFICATION_RESOURCES.WorkforceUserPoolClientId);
    expect(fixtureIdentity.workforceIssuer).toBe(issuerOf('us-east-2_zGOVBoeGT'));
    expect(fixtureIdentity.workforceAudience).toBe(COGNITO_POOLS['us-east-2_zGOVBoeGT']!.client);
  });

  it('every entry says what it expects of MFA, token times and stack values, and every hold names the older issuer by source line', () => {
    for (const entry of QUALIFICATION_ISSUER_RELEASE_MAP) {
      expect(entry.mfaRequirement.note.length, entry.id).toBeGreaterThan(0);
      expect(entry.tokenTimes.note.length, entry.id).toBeGreaterThan(0);
      if (entry.kind === 'runner') expect(entry.stackReads.names.length, entry.id).toBeGreaterThan(0);
      if (entry.workforce?.kind === 'pinned' && entry.workforce.pool === 'us-east-2_ueGlFRbNB' && entry.api !== 'wxv734oi12' && entry.kind !== 'handler')
        expect(entry.hostedHold, entry.id).toMatch(/us-east-2_ueGlFRbNB|older MFA-optional pool/);
    }
    // MFA is required only where a runner actually reads the pool configuration.
    const required = QUALIFICATION_ISSUER_RELEASE_MAP.filter(e => e.mfaRequirement.required).map(e => e.id);
    expect(required).toEqual(['telehealth/qualification-template', 'inventory/fixture-identities', 'fullscript/qualification']);
    expect(COGNITO_POOLS['us-east-2_ueGlFRbNB']!.mfa).toBe('OPTIONAL');
    expect(COGNITO_POOLS['us-east-2_zGOVBoeGT']!.mfa).toBe('ON');
  });
});

describe('one qualification run, one workforce issuer', () => {
  it('HOSTED HOLD: the qualification API as the source pins it today is a mixed issuer, and is refused', () => {
    const pinnedOnQualification = QUALIFICATION_ISSUER_RELEASE_MAP
      .filter(e => (e.api === QUALIFICATION_API_ID || e.api === 'target') && e.workforce?.kind === 'pinned').map(e => e.id);
    expect(pinnedOnQualification).toEqual(['program-api/candidate', 'program-api/successor', 'program-api/restricted-credential', 'program-api/preflight',
      'program-api/update-preflight', 'telehealth/qualification-template', 'inventory/fixture-identities']);
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: pinnedOnQualification })).toBe('mixed_workforce_issuer');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: [...program, ...telehealth] })).toBe('mixed_workforce_issuer');
  });

  it('the program API alone is one issuer, but the older MFA-optional one: refused', () => {
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: program })).toBe('workforce_mfa_not_required');
  });

  it('the isolated fixtures alone are one MFA-required issuer: admitted, with the issuer and client every runner expects', () => {
    expect(assertQualificationIssuerPlan({ apiId: QUALIFICATION_API_ID, entries: [...telehealth, ...inventory] }))
      .toEqual({ workforcePool: 'us-east-2_zGOVBoeGT', workforceIssuer: ISOLATED.workforceIssuer, workforceAudience: ISOLATED.workforceAudience, entries: [...telehealth, ...inventory] });
  });

  it('a binding-supplied runner joins the plan only with the same issuer', () => {
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: [...telehealth, 'clinic-records/runner'] })).toBe('workforce_issuer_unbound');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: [...telehealth, 'clinic-records/runner', 'care/observer'],
      bindings: { 'clinic-records/runner': ISOLATED, 'care/observer': ISOLATED } })).toBe('admitted');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: [...telehealth, 'clinic-records/runner'], bindings: { 'clinic-records/runner': SHARED } })).toBe('mixed_workforce_issuer');
  });

  it('an observed authorizer that disagrees with its runner is refused, issuer or audience', () => {
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: telehealth, observedAuthorizers: { 'telehealth/qualification-template': SHARED } })).toBe('authorizer_issuer_mismatch');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: telehealth,
      observedAuthorizers: { 'telehealth/qualification-template': { ...ISOLATED, workforceAudience: '4s7jgr4o8sqdq7cvo9gmq96e2h' } } })).toBe('authorizer_issuer_mismatch');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: telehealth, observedAuthorizers: { 'telehealth/qualification-template': ISOLATED } })).toBe('admitted');
  });

  it('stacks whose runner never compares the issuer need an observed authorizer: unknown is not "the same"', () => {
    const entries = [...telehealth, 'shared-manifest/candidate-stacks'];
    const bindings = { 'shared-manifest/candidate-stacks': ISOLATED };
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries, bindings })).toBe('authorizer_unobserved');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries, bindings, observedAuthorizers: { 'shared-manifest/candidate-stacks': SHARED } })).toBe('authorizer_issuer_mismatch');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries, bindings, observedAuthorizers: { 'shared-manifest/candidate-stacks': ISOLATED } })).toBe('admitted');
  });

  it('refuses a consumer pool, the production pool, an unknown pool, a wrong client, an unknown entry and another API', () => {
    const bound = (binding: { workforceIssuer: string; workforceAudience: string }) => refusal({ apiId: QUALIFICATION_API_ID, entries: ['clinic-records/runner'], bindings: { 'clinic-records/runner': binding } });
    expect(bound({ workforceIssuer: issuerOf('us-east-2_G2Hvf9wzJ'), workforceAudience: '18q2q70rlsv8ti37knolpq7qsu' })).toBe('issuer_not_workforce_pool');
    expect(bound({ workforceIssuer: issuerOf('us-east-2_AZMa5gxSZ'), workforceAudience: '67moqjql53ms7247tphe5ftpd8' })).toBe('production_issuer_refused');
    expect(bound({ workforceIssuer: issuerOf('us-east-2_FICTIONAL'), workforceAudience: 'fictionalclient0000000000' })).toBe('issuer_unknown');
    expect(bound({ workforceIssuer: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_zGOVBoeGT', workforceAudience: ISOLATED.workforceAudience })).toBe('issuer_unknown');
    expect(bound({ ...ISOLATED, workforceAudience: '4s7jgr4o8sqdq7cvo9gmq96e2h' })).toBe('issuer_unknown');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: ['fictional/runner'] })).toBe('release_map_entry_unknown');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: ['synthetic-care/release'] })).toBe('api_mismatch');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: ['production/clinical-api'] })).toBe('api_mismatch');
    expect(refusal({ apiId: QUALIFICATION_API_ID, entries: [] })).toBe('workforce_issuer_unbound');
  });
});
