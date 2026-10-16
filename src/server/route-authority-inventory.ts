/**
 * Every Desktop API route, by authority family, for the four onboarding cases: an unapproved self-signed-up account,
 * a suspended clinic, a removed membership and a stale (already-issued) token. Checked, not asserted: the test
 * (route-authority-inventory.test.ts) walks src/app/api, refuses a route that is missing or listed twice, and refuses a
 * cell that claims a refusal or a gap without naming a test that exists and says so.
 *
 * Each cell says what the operation's OWN authority check does in one mode. The Desktop's selected clinic is never
 * authority (src/adapters/selected-clinic.server.ts): under `legacy_claims`, the deployed default, the service takes the
 * clinic from the token's claims and then checks current rows; under `database_current`, which is not activated, the
 * service binds the current membership of the subject in the one selected clinic inside the operation's transaction.
 *
 *   refused           the operation's own check refuses; `evidence` names the test
 *   refused_disabled  refused before any request in this mode (family unconverted, release blocked); `evidence` names it
 *   gap               admitted when it should not be; `evidence` names the test that pins it, `decision` the owner
 *   token_lifetime    admitted until the already-issued token expires, because nothing re-reads current rows
 *   not_applicable    the case cannot arise for this family (no clinic authority is exercised); `reason` says why
 *   unverified        no source test was found either way; `reason` says what would settle it. Never a pass.
 */
export type AuthorityCase = 'unapproved_account' | 'suspended_clinic' | 'removed_membership' | 'stale_token';
export type AuthorityMode = 'legacy_claims' | 'database_current';
export type Cell =
  | { result: 'refused' | 'refused_disabled'; evidence: readonly string[] }
  | { result: 'gap'; evidence: readonly string[]; decision: string }
  | { result: 'token_lifetime' | 'not_applicable' | 'unverified'; reason: string; evidence?: readonly string[] };
type Row = Record<AuthorityCase, Cell>;
export type Family = { description: string; upstream: string; legacy_claims: Row; database_current: Row };

/** Evidence is `<test file>::<the start of an it() title in it>`. */
const E = {
  zeroAccessCurrent: 'src/server/unapproved-account-zero-access.test.ts::under clinic-membership sign-in, with every converted family paired',
  zeroAccessLegacy: 'src/server/unapproved-account-zero-access.test.ts::under the legacy sign-in: every entry point refuses',
  legacyUnapproved: 'src/server/clinical-core/legacy-claims-clinic-status.database.test.ts::an unapproved self-signed-up account',
  legacyRemoved: 'src/server/clinical-core/legacy-claims-clinic-status.database.test.ts::a removed (suspended) membership is refused on the next request',
  legacySuspendedGap: "src/server/clinical-core/legacy-claims-clinic-status.database.test.ts::a %s clinic: its clinic list hides it",
  legacyCalendarGap: 'src/server/clinical-core/legacy-claims-clinic-status.database.test.ts::a %s clinic: the calendar the telehealth visit routes authorize from',
  successorClosed: 'src/server/clinical-core/legacy-claims-clinic-status-successor.database.test.ts::a %s clinic: an already-selected session can neither write nor read in it',
  careSibling: "src/server/clinical-core/care-messaging-restricted-credential.database.test.ts::a sibling clinic's practitioner or patient, a token naming the sibling",
  identityRefusals: 'src/server/clinical-core/workforce-current-identity-consent.database.test.ts::refuses no membership, a pending application, a suspension',
  identityStale: 'src/server/clinical-core/workforce-current-identity-consent.database.test.ts::refuses a stale session',
  setterUnapproved: 'src/server/clinical-core/workforce-current-membership-context.database.test.ts::refuses an unapproved subject and a suspended membership',
  setterDisabledClinic: 'src/server/clinical-core/workforce-current-membership-context.database.test.ts::refuses disabled identity, person and clinic',
  careForeign: 'src/server/clinical-core/care-messaging-current-membership.database.test.ts::a member of only another clinic, a pending applicant',
  careRemoved: 'src/server/clinical-core/care-messaging-current-membership.database.test.ts::a suspended or removed membership is refused on the next request',
  careStale: 'src/server/clinical-core/care-messaging-current-membership.database.test.ts::an expired or stale sign-in asks for sign-in again',
  programRemoved: 'src/server/clinical-core/current-membership-program-assignments.database.test.ts::a suspended, removed or pending membership is refused',
  gatedRefused: 'src/server/current-membership-routes.test.ts::stays refused, with no request, unless this deployment pairs the family',
  unconvertedRefused: "src/server/clinic-authority-families.test.ts::privacy operations, lab attestation and the synthetic boundary",
  unconvertedConsult: 'src/server/clinic-authority-families.test.ts::calendar connection, consult and clinic records',
  telehealthRecheck: 'src/server/clinical-core/aws-telehealth-requests.test.ts::rechecks current membership on every request, so an older token loses access',
  telehealthVisitRevoked: 'src/server/clinical-core/aws-telehealth-requests.test.ts::refuses to start, consent or import when the calendar says cancelled, when membership is revoked',
  telehealthCurrentReads: 'src/server/clinical-core/aws-telehealth-current-membership.test.ts::each read rechecks',
  telehealthCurrentWrites: 'src/server/clinical-core/aws-telehealth-current-membership.test.ts::under database_current the same write is refused before the authority read',
  signInNoClinic: 'src/app/api/auth/first-clinic-selection.test.ts::no memberships: signs in with no clinic',
  signInOutage: 'src/app/api/auth/first-clinic-selection.test.ts::an unknown or unverifiable identity, or an outage, selects nothing',
  signInRevocation: 'src/app/api/auth/first-clinic-selection.test.ts::revocation: a clinic that leaves the account',
  signInSuspended: 'src/app/api/auth/clinic-step-journey.test.ts::a clinic suspended during the session leaves the account',
  envClinic: 'src/adapters/config.org-fallback.test.ts::%s: a session with no selected clinic is refused',
  bootstrapBlocked: 'src/server/clinic-bootstrap-route.test.ts::blocked: both reads and creations answer not released',
  bootstrapSuspended: 'src/server/clinic-bootstrap-route.test.ts::a suspended clinic is reported with its reason and no access',
  operatorBlocked: 'src/server/platform-operator-routes.test.ts::ship blocked: every route and the sign-in answer not released',
  operatorSeparate: 'src/server/platform-operator-routes.test.ts::a practitioner session is not an operator session',
  applicantNoClinic: 'src/server/onboarding-routes.test.ts::sends the session token and never a clinic',
  joinLegacy: 'src/server/onboarding-routes.test.ts::does not exist under the legacy sign-in',
  mediaOff: 'src/server/programs/program-media-installed-host.test.ts::is off before file/session/network use with wrong %s',
  mediaExpired: 'src/server/programs/program-media-installed-host.test.ts::passes no token for an expired session',
  legacySignIn: 'src/app/api/auth/first-clinic-selection.test.ts::signs in through list_my_organizations as before',
  campaignIndependent: 'src/server/clinic-authority-families.test.ts::the campaign API still answers under clinic-membership sign-in',
  fullscriptCurrent: 'src/app/api/live/fullscript/clinic-authority.test.ts::a current member reaches each Fullscript operation, after the clinic is re-read',
  fullscriptRemoved: 'src/app/api/live/fullscript/clinic-authority.test.ts::a removed membership or a suspended clinic, absent from the account',
  fullscriptOutage: 'src/app/api/live/fullscript/clinic-authority.test.ts::a clinic read that fails refuses as unavailable',
  fullscriptNoClinic: 'src/app/api/live/fullscript/clinic-authority.test.ts::an account with no clinic (an unapproved sign-up) or an expired session',
  fullscriptEmail: "src/app/api/live/fullscript/clinic-authority.test.ts::a member who edits the display email cookie to a colleague's",
  fullscriptOtherAccount: 'src/app/api/live/fullscript/clinic-authority.test.ts::a clinic chosen by another account in the same browser',
  fullscriptCallback: "src/app/api/live/fullscript/clinic-authority.test.ts::in another account's browser, after the membership is removed",
} as const;

const refused = (...evidence: string[]): Cell => ({ result: 'refused', evidence });
const disabled = (...evidence: string[]): Cell => ({ result: 'refused_disabled', evidence });
const na = (reason: string): Cell => ({ result: 'not_applicable', reason });
const unverified = (reason: string): Cell => ({ result: 'unverified', reason });
const allDisabled = (...evidence: string[]): Row => ({ unapproved_account: disabled(...evidence), suspended_clinic: disabled(...evidence),
  removed_membership: disabled(...evidence), stale_token: disabled(...evidence) });
const allNa = (reason: string): Row => ({ unapproved_account: na(reason), suspended_clinic: na(reason), removed_membership: na(reason), stale_token: na(reason) });
const SUSPENDED_DECISION = 'Brandon with Codex: under legacy claims no operation checks clinical_core.organizations.status, so an already-selected '
  + 'session keeps working in a suspended or archived clinic. The BLOCKED successor legacy-claims-clinic-status.sql refuses every workforce '
  + 'clinical-data request into a clinic that is not active, where every legacy request enters (set_request_context), and deliberately leaves '
  + 'consent management (retention, erasure, recording cleanup), identity linking and consumer requests running. Apply it, or require '
  + 'database_current before any clinic can be suspended. docs/desktop-onboarding-authority-2026-10-16.md';
const STALE_LEGACY = 'The service takes the clinic from the token, then each SQL operation re-reads membership rows, so a removed member is refused on the next request (removed_membership); the token itself stays usable only until API Gateway refuses its exp.';
/** Every case under database_current for a family on the current-membership setter, bound in the transaction. */
const currentRows = (removed: string): Row => ({
  unapproved_account: refused(E.setterUnapproved, E.zeroAccessCurrent),
  suspended_clinic: refused(E.setterDisabledClinic),
  removed_membership: refused(removed),
  stale_token: refused(E.setterUnapproved, E.identityStale),
});

export const ROUTE_FAMILIES = {
  sign_in_and_clinic_choice: {
    description: 'Sign-in, MFA, reset, session refresh and the clinic step: which clinic a session may select, never authority itself',
    upstream: 'Cognito; list_my_organizations (legacy) or subject-only membership discovery (database_current)',
    legacy_claims: { unapproved_account: refused(E.legacySignIn, E.envClinic), suspended_clinic: refused(E.legacySuspendedGap),
      removed_membership: refused(E.legacyRemoved), stale_token: { result: 'token_lifetime', reason: 'An expired session is refreshed by the middleware or signed out; the clinic list is re-read only at sign-in and on the clinic step.' } },
    database_current: { unapproved_account: refused(E.signInNoClinic, E.signInOutage), suspended_clinic: refused(E.signInSuspended),
      removed_membership: refused(E.signInRevocation), stale_token: refused(E.signInOutage) },
  },
  compatibility_rpc: {
    description: 'The clinical workspace through data-compatibility RPCs: patients, charts (emr), inbox, billing, plans, programs, protocols, nutrition, knowledge, lens, copilot, labs, schedule, sync, tasks, reasoning',
    upstream: 'aws-production-clinical-api POST /clinical-core/workforce/data-compatibility (clinicalRpc / clinicalSelect)',
    legacy_claims: { unapproved_account: refused(E.legacyUnapproved, E.zeroAccessLegacy, E.envClinic),
      suspended_clinic: { result: 'gap', evidence: [E.legacySuspendedGap, E.successorClosed], decision: SUSPENDED_DECISION },
      removed_membership: refused(E.legacyRemoved), stale_token: { result: 'token_lifetime', reason: STALE_LEGACY, evidence: [E.legacyRemoved] } },
    database_current: { unapproved_account: refused(E.setterUnapproved, E.zeroAccessCurrent), suspended_clinic: refused(E.setterDisabledClinic),
      removed_membership: refused(E.setterUnapproved), stale_token: refused(E.setterUnapproved) },
  },
  synthetic_identity_boundary: {
    description: 'The synthetic API\'s posture and invitations, claims-based by design',
    upstream: 'aws-identity-api (synthetic) /clinical-core/workforce/{posture,invitations}',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy), suspended_clinic: unverified('The synthetic-staging database (fictional rows, no PHI) decides by claims; its SQL shares the production role helpers, which read no clinic status, but no test loads the synthetic schema to pin it.'),
      removed_membership: unverified('The synthetic posture route reads no membership; invitations use has_clinical_role, untested here.'), stale_token: { result: 'token_lifetime', reason: STALE_LEGACY } },
    database_current: allDisabled(E.unconvertedRefused),
  },
  care_messages: {
    description: 'Patient–practitioner messages (workforce side)',
    upstream: 'care-messaging POST /clinical-core/workforce/messages',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: refused(E.careSibling), removed_membership: refused(E.careSibling),
      stale_token: { result: 'token_lifetime', reason: STALE_LEGACY } },
    database_current: { unapproved_account: refused(E.careForeign, E.gatedRefused), suspended_clinic: refused(E.setterDisabledClinic),
      removed_membership: refused(E.careRemoved), stale_token: refused(E.careStale) },
  },
  program_assignments: {
    description: 'Assigned programs (practitioner side)',
    upstream: 'program API POST /clinical-core/workforce/programs (current-membership program API)',
    legacy_claims: allDisabled(E.gatedRefused, E.zeroAccessLegacy),
    database_current: currentRows(E.programRemoved),
  },
  workforce_join_review: {
    description: 'Join requests and membership revocation by a clinic admin (BLOCKED API)',
    upstream: 'join-review API /clinical-core/workforce/join-requests',
    legacy_claims: allDisabled(E.joinLegacy),
    database_current: allDisabled(E.gatedRefused),
  },
  telehealth_calendar: {
    description: 'Appointment requests, actions, slots and payments',
    upstream: 'telehealth /clinical-core/workforce/appointments/*',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy, E.telehealthRecheck), suspended_clinic: refused(E.telehealthRecheck),
      removed_membership: refused(E.telehealthRecheck), stale_token: refused(E.telehealthRecheck) },
    database_current: { unapproved_account: refused(E.telehealthCurrentReads), suspended_clinic: refused(E.telehealthCurrentReads),
      removed_membership: refused(E.telehealthCurrentReads), stale_token: refused(E.telehealthCurrentReads) },
  },
  telehealth_visits: {
    description: 'Visit consent, start, end, notes, signing and chart transfer',
    upstream: 'telehealth /clinical-core/workforce/appointments/visits/*',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: { result: 'gap', evidence: [E.legacyCalendarGap, E.successorClosed], decision: SUSPENDED_DECISION },
      removed_membership: refused(E.telehealthVisitRevoked), stale_token: refused(E.telehealthVisitRevoked) },
    database_current: { unapproved_account: refused(E.telehealthCurrentReads), suspended_clinic: refused(E.telehealthCurrentReads),
      removed_membership: refused(E.telehealthCurrentWrites), stale_token: refused(E.telehealthCurrentWrites) },
  },
  unconverted_claims_families: {
    description: 'Encounter recording, calendar connection, patient notification settings, workforce Ask ALP, privacy operations, lab attestation, consult links/requests/records/retention/disputes/outcomes/carts/note templates',
    upstream: 'claims-based workforce services (recording, identity API workforce routes, privacy operations, lab attestation)',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: unverified('Each service enters through set_request_context with the claimed clinic. The clinic-status successor refuses the ones that use clinical_data and deliberately not the consent_management ones (recording cleanup, retention); neither is pinned family by family.'),
      removed_membership: unverified('Each service has its own membership check; this inventory does not pin them family by family.'),
      stale_token: { result: 'token_lifetime', reason: STALE_LEGACY } },
    database_current: allDisabled(E.unconvertedRefused, E.unconvertedConsult),
  },
  governed_catalog: {
    description: 'The governed product catalog read for Program Studio',
    upstream: 'aws-governed-catalog-api /clinical-core/workforce/catalog/*',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy), suspended_clinic: unverified('The governed product catalog is not clinic data and is read by claims; its SQL (catalog-migrations) is not loaded by these tests.'),
      removed_membership: unverified('The catalog SQL\'s require_catalog_member reads membership rows inline; no test loads the catalog schema to pin it.'), stale_token: { result: 'token_lifetime', reason: STALE_LEGACY } },
    database_current: { unapproved_account: refused(E.zeroAccessCurrent), suspended_clinic: unverified('Production catalog SQL is unregistered; it fails closed but is not pinned per case.'),
      removed_membership: unverified('Production catalog SQL is unregistered; a removed membership is not pinned for the catalog read.'),
      stale_token: unverified('Production catalog SQL is unregistered; an already-issued token is not pinned for the catalog read.') },
  },
  legacy_backend: {
    description: 'Routes still served by the transitional tRPC backend or its fixture: lab upload and document read, scribe chunk/consent/recording/transcript',
    upstream: 'TRPC_BASE_URL (not an AWS clinical API in this repository; fixture-only for the scribe routes)',
    legacy_claims: { unapproved_account: refused(E.envClinic), suspended_clinic: unverified('The legacy host is outside this repository.'),
      removed_membership: unverified('The legacy host is outside this repository.'), stale_token: unverified('The legacy host is outside this repository.') },
    database_current: { unapproved_account: refused(E.envClinic), suspended_clinic: unverified('The legacy host is outside this repository.'),
      removed_membership: unverified('The legacy host is outside this repository.'), stale_token: unverified('The legacy host is outside this repository.') },
  },
  fullscript_connection: {
    description: 'The practitioner\'s Fullscript connection in one clinic (OAuth start/callback, status, action, disconnect). Each '
      + 'request re-reads the account\'s current clinics before the connection is touched, the practitioner is the ID token\'s '
      + 'email (not the display cookie), and the callback completes only in the session that started it',
    upstream: 'Fullscript API and the DynamoDB token store; the clinic list (list_my_organizations or subject-only discovery) as the authority read',
    legacy_claims: { unapproved_account: refused(E.fullscriptNoClinic, E.fullscriptEmail),
      suspended_clinic: refused(E.fullscriptRemoved, E.legacySuspendedGap), removed_membership: refused(E.fullscriptRemoved, E.fullscriptCallback),
      stale_token: refused(E.fullscriptRemoved, E.fullscriptNoClinic, E.fullscriptOutage) },
    database_current: { unapproved_account: refused(E.fullscriptNoClinic, E.fullscriptOtherAccount),
      suspended_clinic: refused(E.fullscriptRemoved, E.signInSuspended), removed_membership: refused(E.fullscriptRemoved, E.fullscriptCallback),
      stale_token: refused(E.fullscriptRemoved, E.fullscriptNoClinic, E.fullscriptOutage) },
  },
  campaigns: {
    description: 'The campaign engine (marketing; never clinical data)',
    upstream: 'campaign API (its own authorizer; practice from the token)',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy), suspended_clinic: { result: 'token_lifetime', reason: 'The campaign store has no clinic status; a practice is the token\'s claim until it expires.' },
      removed_membership: { result: 'token_lifetime', reason: 'No membership rows in the campaign store; the claim stands until the token expires.' },
      stale_token: { result: 'token_lifetime', reason: 'Claims-based by design.' } },
    database_current: { unapproved_account: refused(E.campaignIndependent), suspended_clinic: { result: 'token_lifetime', reason: 'Independent of clinical authority; as under legacy.' },
      removed_membership: { result: 'token_lifetime', reason: 'As under legacy.' }, stale_token: { result: 'token_lifetime', reason: 'As under legacy.' } },
  },
  applicant: {
    description: 'Applying to a clinic and the BLOCKED new-clinic bootstrap: an applicant has no clinic by definition',
    upstream: 'applicant API /clinical-core/workforce/{applications,clinic-bootstrap}',
    legacy_claims: { unapproved_account: na('This is the unapproved account\'s own door; it acts on the subject alone and never names a clinic.'),
      suspended_clinic: refused(E.bootstrapSuspended), removed_membership: na('No membership is exercised.'), stale_token: refused(E.applicantNoClinic) },
    database_current: { unapproved_account: na('As under legacy.'), suspended_clinic: refused(E.bootstrapSuspended),
      removed_membership: na('No membership is exercised.'), stale_token: refused(E.bootstrapBlocked) },
  },
  platform_operator: {
    description: 'The platform-operator console (BLOCKED release; separate TOTP sign-in and cookie scoped to /api/operator)',
    upstream: 'operator API /clinical-core/platform-operator/*',
    legacy_claims: allDisabled(E.operatorBlocked, E.operatorSeparate),
    database_current: allDisabled(E.operatorBlocked, E.operatorSeparate),
  },
  program_media: {
    description: 'Lesson media authoring on the fictional qualification host (designated subject only, PHI off, activation blocked)',
    upstream: 'in-process qualification host (RDS Data API, S3, Cognito AdminGetUser)',
    legacy_claims: allDisabled(E.mediaOff, E.mediaExpired),
    database_current: allDisabled(E.mediaOff, E.mediaExpired),
  },
  learner: {
    description: 'My courses: the consumer learner surface (consumer pool, no workforce clinic)',
    upstream: 'learner host (reviewed host or fixture only)',
    legacy_claims: allNa('A consumer session; no workforce membership or clinic selection is exercised.'),
    database_current: allNa('As under legacy.'),
  },
  no_clinical_authority: {
    description: 'Health, posture/status reports, local parsers and fixture-only commerce, public pages and signed inbound webhooks',
    upstream: 'none, the fixture, the campaign API\'s public endpoints, or a provider webhook signature',
    legacy_claims: allNa('No clinic authority is exercised: local computation, a public page, a fixture, or a signature-verified webhook.'),
    database_current: allNa('As under legacy.'),
  },
} satisfies Record<string, Family>;
export type RouteFamily = keyof typeof ROUTE_FAMILIES;

/** Families by route (relative to src/app/api, without /route.ts). Exact entries win over prefixes; the longest prefix wins. */
export const ROUTE_FAMILY_EXACT: Readonly<Record<string, RouteFamily>> = {
  health: 'no_clinical_authority', 'knowledge/authoring-pack': 'no_clinical_authority', 'live/posture': 'no_clinical_authority',
  'live/knowledge/copilot-status': 'no_clinical_authority', 'live/knowledge/import-parse': 'no_clinical_authority',
  'live/nutrition/provider-status': 'no_clinical_authority', 'live/plans/stripe-status': 'no_clinical_authority',
  'live/commerce/checkout': 'no_clinical_authority', 'live/commerce/fixture': 'no_clinical_authority', 'live/commerce/status': 'no_clinical_authority',
  'live/commerce/webhook': 'no_clinical_authority', 'live/stripe/webhook': 'no_clinical_authority',
  'live/commerce/offers': 'compatibility_rpc', 'live/programs/offer': 'compatibility_rpc', 'live/programs/catalog': 'governed_catalog',
  'live/clinical-core/posture': 'synthetic_identity_boundary', 'live/sync/synthetic-invite': 'synthetic_identity_boundary',
  'live/care-messages': 'care_messages', 'live/program-assignments': 'program_assignments', 'live/org/join-requests': 'workforce_join_review',
  'live/labs/upload': 'legacy_backend', 'live/labs/document/[documentId]': 'legacy_backend',
  'live/scribe/chunk': 'legacy_backend', 'live/scribe/consent': 'legacy_backend', 'live/scribe/recording': 'legacy_backend', 'live/scribe/transcript': 'legacy_backend',
  'live/campaigns': 'campaigns', 'my-courses': 'learner',
  'live/telehealth-payments': 'telehealth_calendar', 'live/telehealth-requests': 'telehealth_calendar', 'live/telehealth-slots': 'telehealth_calendar',
};
export const ROUTE_FAMILY_PREFIXES: Readonly<Record<string, RouteFamily>> = {
  'auth/': 'sign_in_and_clinic_choice', 'onboarding/': 'applicant', 'operator/': 'platform_operator', 'public/': 'no_clinical_authority',
  'live/programs/media/': 'program_media', 'live/telehealth/': 'telehealth_visits', 'live/fullscript/': 'fullscript_connection',
  'live/scribe/': 'unconverted_claims_families', 'live/recording-cleanup-': 'unconverted_claims_families', 'live/calendar-connection': 'unconverted_claims_families',
  'live/patient-notification-settings': 'unconverted_claims_families', 'live/ask-alp/': 'unconverted_claims_families',
  'live/privacy-operations': 'unconverted_claims_families', 'live/lab-attestations': 'unconverted_claims_families',
  'live/care-governance': 'unconverted_claims_families', 'live/clinic-records': 'unconverted_claims_families', 'live/consult-': 'unconverted_claims_families',
  'live/note-templates': 'unconverted_claims_families', 'live/practice-outcomes': 'unconverted_claims_families', 'live/protocol-carts': 'unconverted_claims_families',
  'live/': 'compatibility_rpc',
};
export function routeFamily(route: string): RouteFamily | null {
  if (Object.hasOwn(ROUTE_FAMILY_EXACT, route)) return ROUTE_FAMILY_EXACT[route]!;
  const prefix = Object.keys(ROUTE_FAMILY_PREFIXES).filter(p => route.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  return prefix ? ROUTE_FAMILY_PREFIXES[prefix]! : null;
}
