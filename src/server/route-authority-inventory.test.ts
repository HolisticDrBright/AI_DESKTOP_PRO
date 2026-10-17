import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_FAMILIES, ROUTE_FAMILY_EXACT, ROUTE_FAMILY_PREFIXES, routeFamily, type AuthorityCase, type AuthorityMode, type Cell } from './route-authority-inventory';

/** The inventory is a claim about source; this holds it to the source. */
const API = join(process.cwd(), 'src/app/api');
function routes(dir = API): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routes(path);
    return name === 'route.ts' ? [relative(API, dir).split('\\').join('/')] : [];
  });
}
const ALL = routes().sort();
const MODES: AuthorityMode[] = ['legacy_claims', 'database_current'];
const CASES: AuthorityCase[] = ['unapproved_account', 'suspended_clinic', 'removed_membership', 'stale_token', 'compromised_identity'];
const cells = Object.entries(ROUTE_FAMILIES).flatMap(([family, row]) =>
  MODES.flatMap(mode => CASES.map(kase => ({ family, mode, kase, cell: (row[mode] as Record<AuthorityCase, Cell>)[kase] }))));

describe('every Desktop API route has exactly one authority family', () => {
  it('walks all route files', () => {
    expect(ALL.length).toBeGreaterThan(250);
    const unmapped = ALL.filter(route => routeFamily(route) === null);
    expect(unmapped).toEqual([]);
  });
  it('lists no route that does not exist, and no prefix that matches nothing', () => {
    expect(Object.keys(ROUTE_FAMILY_EXACT).filter(route => !ALL.includes(route))).toEqual([]);
    expect(Object.keys(ROUTE_FAMILY_PREFIXES).filter(prefix => !ALL.some(route => route.startsWith(prefix)))).toEqual([]);
  });
  it('every family is the family of some route', () => {
    const used = new Set(ALL.map(route => routeFamily(route)));
    expect(Object.keys(ROUTE_FAMILIES).filter(family => !used.has(family as never))).toEqual([]);
  });
  it('the route families the onboarding review names land where their authority actually lives', () => {
    expect(routeFamily('live/emr/note')).toBe('compatibility_rpc'); // charts
    expect(routeFamily('live/billing/invoice')).toBe('compatibility_rpc');
    expect(routeFamily('live/care-messages')).toBe('care_messages');
    expect(routeFamily('live/program-assignments')).toBe('program_assignments');
    expect(routeFamily('live/privacy-operations')).toBe('unconverted_claims_families'); // export and corrections
    expect(routeFamily('live/telehealth/start')).toBe('telehealth_visits'); // provider visits
    expect(routeFamily('live/clinical-core/posture')).toBe('synthetic_identity_boundary'); // identity and consent
    expect(routeFamily('auth/org')).toBe('sign_in_and_clinic_choice'); // the compatibility fallback's clinic choice
    expect(routeFamily('onboarding/clinic-bootstrap')).toBe('applicant');
    expect(routeFamily('operator/session')).toBe('platform_operator');
  });
});

describe('every cell is backed by source, or says it is not', () => {
  it.each(cells.map(c => [`${c.family} / ${c.mode} / ${c.kase}`, c.cell] as const))('%s', (_name, cell) => {
    if (cell.result === 'refused' || cell.result === 'refused_disabled' || cell.result === 'gap') expect(cell.evidence.length).toBeGreaterThan(0);
    else if ('reason' in cell) expect(cell.reason.length).toBeGreaterThan(10);
    else throw new Error(`${cell.result} needs a reason`);
    if (cell.result === 'gap') expect(cell.decision).toMatch(/docs\/desktop-onboarding-authority-2026-10-16\.md/);
    for (const evidence of ('evidence' in cell ? cell.evidence ?? [] : [])) {
      const [file, title] = evidence.split('::');
      expect(existsSync(join(process.cwd(), file!)), evidence).toBe(true);
      expect(title!.length, evidence).toBeGreaterThan(10);
      expect(readFileSync(join(process.cwd(), file!), 'utf8'), evidence).toContain(title!);
    }
  });
  it('the open gaps and unverified cells are exactly these; closing or finding one updates this list deliberately', () => {
    const named = (result: Cell['result']) => cells.filter(c => c.cell.result === result).map(c => `${c.family}/${c.mode}/${c.kase}`).sort();
    // The compromised-identity case (a login revoked by the BLOCKED emergency revocation, its token unexpired) adds the
    // campaign engine's gap in both modes and the transitional lab host's fifth unverified persona.
    expect(named('gap')).toEqual(['campaigns/database_current/compromised_identity', 'campaigns/legacy_claims/compromised_identity',
      'compatibility_rpc/legacy_claims/suspended_clinic', 'synthetic_identity_boundary/legacy_claims/suspended_clinic',
      'telehealth_visits/legacy_claims/suspended_clinic', 'unconverted_claims_families/legacy_claims/suspended_clinic']);
    expect(named('unverified')).toEqual(['transitional_lab_documents/legacy_claims/compromised_identity',
      'transitional_lab_documents/legacy_claims/removed_membership', 'transitional_lab_documents/legacy_claims/stale_token',
      'transitional_lab_documents/legacy_claims/suspended_clinic', 'transitional_lab_documents/legacy_claims/unapproved_account']);
    const counts = Object.fromEntries(['refused', 'refused_disabled', 'gap', 'token_lifetime', 'not_applicable', 'unverified']
      .map(result => [result, named(result as Cell['result']).length]));
    expect(counts).toEqual({ refused: 72, refused_disabled: 60, gap: 6, token_lifetime: 23, not_applicable: 24, unverified: 5 });
    // Every clinical-data family refuses a revoked login under both authorities; what does not is named above or reads no clinic data.
    const revoked = cells.filter(c => c.kase === 'compromised_identity' && c.cell.result === 'refused').map(c => `${c.family}/${c.mode}`).sort();
    expect(revoked).toEqual(['care_messages/database_current', 'care_messages/legacy_claims', 'compatibility_rpc/database_current',
      'compatibility_rpc/legacy_claims', 'fullscript_connection/database_current', 'fullscript_connection/legacy_claims',
      'program_assignments/database_current', 'sign_in_and_clinic_choice/database_current', 'sign_in_and_clinic_choice/legacy_claims',
      'telehealth_calendar/database_current', 'telehealth_calendar/legacy_claims', 'telehealth_visits/database_current',
      'telehealth_visits/legacy_claims', 'unconverted_claims_families/legacy_claims']);
  });
});
