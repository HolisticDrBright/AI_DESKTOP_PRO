/**
 * Every Desktop API route, by authority family, for five cases: an unapproved self-signed-up account, a suspended
 * clinic, a removed membership, a stale (already-issued) token, and a compromised identity: a practitioner login whose
 * workforce identity the BLOCKED emergency revocation has disabled while its token is still unexpired. Checked, not asserted: the test
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
export type AuthorityCase = 'unapproved_account' | 'suspended_clinic' | 'removed_membership' | 'stale_token' | 'compromised_identity';
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
  custodyPreSuspension: 'src/server/clinical-core/suspended-clinic-custody.database.test.ts::commits, the same already-issued session',
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
  scribeDeployed: 'src/server/legacy-backend-routes.test.ts::under %s on a deployment: every entry point refuses before any request',
  scribeAwsOrigin: 'src/server/legacy-backend-routes.test.ts::with an AWS recording origin configured, even where the local fixture is allowed',
  labCurrent: 'src/server/legacy-backend-routes.test.ts::under clinic-membership sign-in: refused before the token leaves',
  labLegacy: 'src/server/legacy-backend-routes.test.ts::under the legacy sign-in: the token goes to the transitional host and no clinic does',
  catalogSynthetic: 'src/server/clinical-core/governed-catalog-authority.database.test.ts::an already-issued token naming a clinic that is suspended, archived or has no membership row',
  catalogSuspended: 'src/server/clinical-core/governed-catalog-authority.database.test.ts::a %s clinic: the same already-issued token is refused on the next read',
  catalogRemoved: 'src/server/clinical-core/governed-catalog-authority.database.test.ts::a removed membership: the same already-issued token is refused on the next read',
  recordingRemoved: 'src/server/clinical-core/unconverted-families-clinic-status.database.test.ts::encounter recording: a removed membership is refused on the next request',
  recordingSuspended: 'src/server/clinical-core/unconverted-families-clinic-status.database.test.ts::encounter recording: a %s clinic — ',
  privacyAssignment: 'src/server/clinical-core/unconverted-families-clinic-status.database.test.ts::privacy operations: decided by the operator assignment, not clinic membership or clinic status',
  recordingCleanupRemoved: 'src/server/clinical-core/encounter-recording-authority.database.test.ts::refuses a disabled workforce identity and suspended membership even with an assignment',
  labAttestationRemoved: 'src/server/clinical-core/lab-attestation-review.database.test.ts::refuses a reviewer whose authority was withdrawn after the view loaded',
  recordingCaptureRemoved: 'src/server/clinical-core/recording-transcription.database.test.ts::capture (segment with an already-issued capture token, state, readiness), the transcript list and the proposed-note list',
  syntheticFamiliesRemoved: 'src/server/clinical-core/unconverted-families-removed-membership.database.test.ts::unconverted synthetic families: a removed membership is refused on the next request',
  calendarBusyRemoved: 'src/server/clinical-core/unconverted-families-removed-membership.database.test.ts::calendar busy sync: the membership is checked before the request is read',
  notificationSettingsRemoved: 'src/server/notifications/patient-notifications.database.test.ts::a member whose membership is removed is refused on the next read',
  clinicRecordsRemoved: 'src/server/clinical-core/clinic-record-privacy.database.test.ts::leaks no row, text or receipt metadata across patients, clinics, roles or pools',
  syntheticInviteRemoved: 'src/server/clinical-core/synthetic-identity-boundary-authority.database.test.ts::invitations: a removed membership is refused on the next request',
  syntheticInviteSuspended: 'src/server/clinical-core/synthetic-identity-boundary-authority.database.test.ts::invitations: a %s clinic — GAP: the already-selected session still issues one',
  syntheticPosture: 'src/server/clinical-core/synthetic-identity-boundary-authority.database.test.ts::posture: answered from the token alone',
  syntheticSuccessorIssue: 'src/server/clinical-core/synthetic-invitation-clinic-status.database.test.ts::clinic, already-issued practitioner session: ${withSuccessor ? \'refused, nothing written\'',
  syntheticSuccessorClaim: 'src/server/clinical-core/synthetic-invitation-clinic-status.database.test.ts::an invitation issued before the suspension, claimed after it',
  syntheticSuccessorRace: 'scripts/qualify-synthetic-invitation-native.mjs::issue-waiting-on-a-pending-suspension-is-refused',
  revokedLogin: 'src/server/clinical-core/workforce-identity-emergency-revocation.database.test.ts::one decision disables the login in every clinic; the next request is refused whatever the token',
  revokedLoginService: 'src/server/clinical-core/workforce-identity-emergency-revocation.database.test.ts::a delayed provider answer never delays the refusal',
  revokedLoginRace: 'scripts/qualify-emergency-revocation-native.mjs::request-waiting-on-a-pending-revocation-is-refused',
  revokedLoginCurrent: 'scripts/qualify-emergency-revocation-native.mjs::current-authority-and-another-clinic-are-refused-too',
  custodyCompromised: 'src/server/clinical-core/suspended-clinic-custody.database.test.ts::a compromised credential is ended by disabling its identity',
  discoveryDisabled: 'src/server/clinical-core/workforce-membership-discovery.database.test.ts::refuses an unknown, disabled or consumer identity',
  syntheticRevoked: 'src/server/clinical-core/synthetic-identity-boundary-authority.database.test.ts::a disabled workforce identity (a revoked login): invitations refused on the next request',
  applicantCognito: 'src/server/clinical-core/aws-workforce-applicant-identity.test.ts::refuses %s without returning an applicant',
  campaignsRevoked: 'src/campaigns/staff-revocation.test.ts::is refused for every kind of staff operation, before anything is read, changed or sent',
  campaignsSignalOutage: 'src/campaigns/staff-revocation.test.ts::a signal that cannot be read refuses every staff operation with 503, and changes nothing',
  campaignsSignalWire: 'src/integration/staff-revocation-signal.test.ts::what the emergency revocation publishes, the campaign staff route refuses',
  campaignsSignalRecorded: 'src/server/clinical-core/workforce-revocation-campaign-signal.database.test.ts::the signal goes first; a signal outage never delays the login refusal',
} as const;

const refused = (...evidence: string[]): Cell => ({ result: 'refused', evidence });
const disabled = (...evidence: string[]): Cell => ({ result: 'refused_disabled', evidence });
const na = (reason: string): Cell => ({ result: 'not_applicable', reason });
const unverified = (reason: string, ...evidence: string[]): Cell => ({ result: 'unverified', reason, ...(evidence.length ? { evidence } : {}) });
const allDisabled = (...evidence: string[]): Row => ({ unapproved_account: disabled(...evidence), suspended_clinic: disabled(...evidence),
  removed_membership: disabled(...evidence), stale_token: disabled(...evidence), compromised_identity: disabled(...evidence) });
const allNa = (reason: string): Row => ({ unapproved_account: na(reason), suspended_clinic: na(reason), removed_membership: na(reason), stale_token: na(reason),
  compromised_identity: na(reason) });
/** A revoked login under legacy claims: set_request_context, the entry every legacy workforce request takes, reads the
 * identity row on every request (and, with the BLOCKED candidate, holds it for the operation), so the next request is
 * refused in every clinic, before any operation. */
const REVOKED_LEGACY: Cell = { result: 'refused', evidence: [E.revokedLogin, E.revokedLoginRace, E.custodyCompromised] };
/** The same under database_current: the setter share-locks and checks the identity row. */
const REVOKED_CURRENT: Cell = { result: 'refused', evidence: [E.setterDisabledClinic, E.revokedLoginCurrent] };
/** A revoked login at the campaign API: its staff route reads the emergency revocation's signal before every staff
 * operation and refuses when it cannot (src/campaigns/staff-revocation.ts). The signal is published by the BLOCKED
 * revocation as a recorded third step (workforce-revocation-campaign-signal.sql), like the identity row every other
 * family reads. docs/campaign-staff-revocation-2026-10-17.md */
const REVOKED_CAMPAIGNS: Cell = { result: 'refused', evidence: [E.campaignsRevoked, E.campaignsSignalOutage, E.campaignsSignalWire, E.campaignsSignalRecorded] };
const SUSPENDED_DECISION = 'Brandon with Codex: under legacy claims the clinical path never checks clinical_core.organizations.status, so an '
  + 'already-selected session keeps working in a suspended or archived clinic. The BLOCKED successor legacy-claims-clinic-status.sql refuses '
  + 'every workforce clinical-data and identity-linking request into a clinic that is not active, where every legacy request enters '
  + '(set_request_context). It admits workforce consent management and every consumer request at that entry. Of the workforce '
  + 'consent-management paths, the retention service and assigned privacy operators run in a closed clinic; recording cleanup refuses '
  + 'itself there (its own operator check); and a practitioner\'s own consent decision is refused only by the separate BLOCKED '
  + 'workforce-consent-decision-clinic-status.sql. The owner ruled that successor out for ordinary suspension (it ends every existing '
  + 'session at once) and chose: an already-valid session continues read-only until its own token expires, a refreshed token does not. '
  + 'The BLOCKED workforce-ordinary-suspension-window.sql (on the emergency revocation) enforces that for the callers that send the '
  + 'verified token\'s iat/exp (the production Desktop RPC, behind its own release switch) and refuses every caller that does not; '
  + 'until it is applied, or database_current is required, this cell stays a gap. docs/desktop-onboarding-authority-2026-10-16.md, '
  + 'docs/suspended-clinic-custody-2026-10-16.md, docs/ordinary-suspension-window-2026-10-17.md';
const SYNTHETIC_SUSPENDED_DECISION = 'Brandon with Codex: the synthetic-staging boundary (fictional rows, no PHI) reads no clinic status, so a '
  + 'session already in a suspended or archived synthetic clinic still issues patient invitations, and one issued before the suspension is '
  + 'still claimed into a verified connection. The production successor does not reach this schema. The separate BLOCKED successor '
  + 'synthetic-invitation-clinic-status.sql refuses both the issue and the claim unless the clinic is active, holding the clinic row so a '
  + 'suspension and either call serialize; a connection verified earlier is left as it is. Apply it, or retire the synthetic boundary before '
  + 'any synthetic clinic is suspended. docs/desktop-onboarding-authority-2026-10-16.md, docs/suspended-clinic-custody-2026-10-16.md';
const CATALOG_HOSTS = 'The Desktop reads the synthetic, PHI-disabled catalog host or the production one by runtime, not by authority mode. '
  + 'The synthetic host (the one deployed; reference rows only, no clinic data) has no clinic or membership table: it admits an already-issued '
  + 'token until it expires. The production host binds the current membership in the read\'s own transaction (BLOCKED setter) and refuses.';
const LAB_HOST = 'The transitional host at TRPC_BASE_URL (deployed as DEPLOYED_TRPC_BASE_URL; not in this repository) decides with the bearer '
  + 'token alone, under its own row-level security; the Desktop sends it no clinic (pinned). Its last known source (V2 expo/backend/labs/'
  + 'upload-route.ts, Supabase RLS under the caller\'s JWT) was deleted from V2 at b2850a2 on 22 July and is on no current branch, and the '
  + 'deployed build is unknown, so no source test can stand for it. Settling this needs the hosted four-persona probe in '
  + 'docs/route-authority-unverified-2026-10-16.md: an unapproved account, a member of a suspended clinic, a removed member and an '
  + 'already-issued token, each against upload and document read, expecting 401/403 and no row or object written or returned.';
const STALE_LEGACY = 'The service takes the clinic from the token, then each SQL operation re-reads membership rows, so a removed member is refused on the next request (removed_membership); the token itself stays usable only until API Gateway refuses its exp.';
/** Every case under database_current for a family on the current-membership setter, bound in the transaction. */
const currentRows = (removed: string): Row => ({
  unapproved_account: refused(E.setterUnapproved, E.zeroAccessCurrent),
  suspended_clinic: refused(E.setterDisabledClinic),
  removed_membership: refused(removed),
  stale_token: refused(E.setterUnapproved, E.identityStale),
  compromised_identity: REVOKED_CURRENT,
});

export const ROUTE_FAMILIES = {
  sign_in_and_clinic_choice: {
    description: 'Sign-in, MFA, reset, session refresh and the clinic step: which clinic a session may select, never authority itself',
    upstream: 'Cognito; list_my_organizations (legacy) or subject-only membership discovery (database_current)',
    legacy_claims: { unapproved_account: refused(E.legacySignIn, E.envClinic), suspended_clinic: refused(E.legacySuspendedGap),
      removed_membership: refused(E.legacyRemoved), stale_token: { result: 'token_lifetime', reason: 'An expired session is refreshed by the middleware or signed out; the clinic list is re-read only at sign-in and on the clinic step.' },
      compromised_identity: REVOKED_LEGACY },
    database_current: { unapproved_account: refused(E.signInNoClinic, E.signInOutage), suspended_clinic: refused(E.signInSuspended),
      removed_membership: refused(E.signInRevocation), stale_token: refused(E.signInOutage), compromised_identity: refused(E.discoveryDisabled) },
  },
  compatibility_rpc: {
    description: 'The clinical workspace through data-compatibility RPCs: patients, charts (emr), inbox, billing, plans, programs, protocols, nutrition, knowledge, lens, copilot, labs, schedule, sync, tasks, reasoning',
    upstream: 'aws-production-clinical-api POST /clinical-core/workforce/data-compatibility (clinicalRpc / clinicalSelect)',
    legacy_claims: { unapproved_account: refused(E.legacyUnapproved, E.zeroAccessLegacy, E.envClinic),
      suspended_clinic: { result: 'gap', evidence: [E.legacySuspendedGap, E.successorClosed, E.custodyPreSuspension], decision: SUSPENDED_DECISION },
      removed_membership: refused(E.legacyRemoved), stale_token: { result: 'token_lifetime', reason: STALE_LEGACY, evidence: [E.legacyRemoved] },
      compromised_identity: REVOKED_LEGACY },
    database_current: { unapproved_account: refused(E.setterUnapproved, E.zeroAccessCurrent), suspended_clinic: refused(E.setterDisabledClinic),
      removed_membership: refused(E.setterUnapproved), stale_token: refused(E.setterUnapproved), compromised_identity: REVOKED_CURRENT },
  },
  synthetic_identity_boundary: {
    description: 'The synthetic API\'s posture and invitations, claims-based by design',
    upstream: 'aws-identity-api (synthetic) /clinical-core/workforce/{posture,invitations}',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: { result: 'gap', decision: SYNTHETIC_SUSPENDED_DECISION,
        evidence: [E.syntheticInviteSuspended, E.syntheticPosture, E.syntheticSuccessorIssue, E.syntheticSuccessorClaim, E.syntheticSuccessorRace] },
      removed_membership: { result: 'token_lifetime', reason: 'Invitations re-read the membership row and refuse a removed member on the next request; posture is answered from the token alone (no clinic data) until it expires.',
        evidence: [E.syntheticInviteRemoved, E.syntheticPosture] },
      stale_token: { result: 'token_lifetime', reason: STALE_LEGACY },
      compromised_identity: { result: 'token_lifetime', reason: 'Invitations enter the synthetic set_request_context, which reads the identity row, and refuse a revoked login on the next request; posture is answered from the token alone (environment, pool and classification; no clinic data) until it expires. The emergency revocation candidate itself is production-only.',
        evidence: [E.syntheticRevoked] } },
    database_current: allDisabled(E.unconvertedRefused),
  },
  care_messages: {
    description: 'Patient–practitioner messages (workforce side)',
    upstream: 'care-messaging POST /clinical-core/workforce/messages',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: refused(E.careSibling), removed_membership: refused(E.careSibling),
      stale_token: { result: 'token_lifetime', reason: STALE_LEGACY }, compromised_identity: REVOKED_LEGACY },
    database_current: { unapproved_account: refused(E.careForeign, E.gatedRefused), suspended_clinic: refused(E.setterDisabledClinic),
      removed_membership: refused(E.careRemoved), stale_token: refused(E.careStale), compromised_identity: REVOKED_CURRENT },
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
      removed_membership: refused(E.telehealthRecheck), stale_token: refused(E.telehealthRecheck),
      compromised_identity: refused(E.telehealthRecheck, E.revokedLogin) },
    database_current: { unapproved_account: refused(E.telehealthCurrentReads), suspended_clinic: refused(E.telehealthCurrentReads),
      removed_membership: refused(E.telehealthCurrentReads), stale_token: refused(E.telehealthCurrentReads),
      compromised_identity: refused(E.telehealthCurrentReads, E.identityRefusals) },
  },
  telehealth_visits: {
    description: 'Visit consent, start, end, notes, signing and chart transfer',
    upstream: 'telehealth /clinical-core/workforce/appointments/visits/*',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: { result: 'gap', evidence: [E.legacyCalendarGap, E.successorClosed], decision: SUSPENDED_DECISION },
      removed_membership: refused(E.telehealthVisitRevoked), stale_token: refused(E.telehealthVisitRevoked),
      compromised_identity: refused(E.telehealthVisitRevoked, E.revokedLogin) },
    database_current: { unapproved_account: refused(E.telehealthCurrentReads), suspended_clinic: refused(E.telehealthCurrentReads),
      removed_membership: refused(E.telehealthCurrentWrites), stale_token: refused(E.telehealthCurrentWrites),
      compromised_identity: refused(E.telehealthCurrentReads, E.identityRefusals) },
  },
  unconverted_claims_families: {
    description: 'Encounter recording, calendar connection, patient notification settings, workforce Ask ALP, privacy operations, lab attestation, consult links/requests/records/retention/disputes/outcomes/carts/note templates',
    upstream: 'claims-based workforce services (recording, identity API workforce routes, privacy operations, lab attestation)',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: { result: 'gap', evidence: [E.recordingSuspended, E.privacyAssignment], decision: SUSPENDED_DECISION },
      // Every route of the family, path by path: each operation re-reads the membership row (privacy operations, the
      // operator assignment) on the next request, so a token that still names the clinic reaches nothing.
      removed_membership: refused(E.recordingRemoved, E.recordingCaptureRemoved, E.recordingCleanupRemoved, E.labAttestationRemoved,
        E.clinicRecordsRemoved, E.privacyAssignment, E.syntheticFamiliesRemoved, E.calendarBusyRemoved, E.notificationSettingsRemoved),
      stale_token: { result: 'token_lifetime', reason: STALE_LEGACY },
      compromised_identity: refused(E.revokedLogin, E.custodyCompromised, E.recordingCleanupRemoved, E.labAttestationRemoved) },
    database_current: allDisabled(E.unconvertedRefused, E.unconvertedConsult),
  },
  governed_catalog: {
    description: 'The governed product catalog read for Program Studio',
    upstream: 'aws-governed-catalog-api /clinical-core/workforce/catalog/*',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy),
      suspended_clinic: { result: 'token_lifetime', reason: CATALOG_HOSTS, evidence: [E.catalogSynthetic, E.catalogSuspended] },
      removed_membership: { result: 'token_lifetime', reason: CATALOG_HOSTS, evidence: [E.catalogSynthetic, E.catalogRemoved] },
      stale_token: { result: 'token_lifetime', reason: STALE_LEGACY },
      compromised_identity: { result: 'token_lifetime', reason: CATALOG_HOSTS, evidence: [E.catalogSynthetic] } },
    database_current: { unapproved_account: refused(E.zeroAccessCurrent),
      suspended_clinic: { result: 'token_lifetime', reason: CATALOG_HOSTS, evidence: [E.catalogSynthetic, E.catalogSuspended] },
      removed_membership: { result: 'token_lifetime', reason: CATALOG_HOSTS, evidence: [E.catalogSynthetic, E.catalogRemoved] },
      stale_token: { result: 'token_lifetime', reason: CATALOG_HOSTS, evidence: [E.catalogSynthetic, E.catalogRemoved] },
      compromised_identity: { result: 'token_lifetime', reason: CATALOG_HOSTS, evidence: [E.catalogSynthetic] } },
  },
  transitional_scribe: {
    description: 'The transitional scribe routes (chunk, consent, recording, transcript): a local contract-fixture harness only, refused on '
      + 'every deployment and whenever an AWS recording origin is configured, before any request',
    upstream: 'TRPC_BASE_URL, reached only by the loopback contract fixture',
    legacy_claims: allDisabled(E.scribeDeployed, E.scribeAwsOrigin),
    database_current: allDisabled(E.scribeDeployed, E.scribeAwsOrigin),
  },
  transitional_lab_documents: {
    description: 'Lab PDF upload and the original lab-document read, still served by the transitional host',
    upstream: 'TRPC_BASE_URL /api/clinical/labs/upload and /api/clinical/labs/document/:id (not an AWS clinical API; not in this repository)',
    legacy_claims: { unapproved_account: unverified(LAB_HOST, E.labLegacy), suspended_clinic: unverified(LAB_HOST, E.labLegacy),
      removed_membership: unverified(LAB_HOST, E.labLegacy), stale_token: unverified(LAB_HOST, E.labLegacy),
      compromised_identity: unverified(LAB_HOST + ' A revoked login is the fifth persona: its unexpired token against both requests after the revocation.', E.labLegacy) },
    database_current: allDisabled(E.labCurrent, E.zeroAccessCurrent),
  },
  fullscript_connection: {
    description: 'The practitioner\'s Fullscript connection in one clinic (OAuth start/callback, status, action, disconnect). Each '
      + 'request re-reads the account\'s current clinics before the connection is touched and again before a provider answer is '
      + 'returned, the connection is keyed by the ID token\'s subject (an older email-keyed row is never claimed) and bound to the '
      + 'membership generation it was installed under (a removed and re-added member reconnects), lab checkout is '
      + 'held, and the callback completes only in the session that started it',
    upstream: 'Fullscript API and the DynamoDB token store; the clinic list (list_my_organizations or subject-only discovery) as the authority read',
    legacy_claims: { unapproved_account: refused(E.fullscriptNoClinic, E.fullscriptEmail),
      suspended_clinic: refused(E.fullscriptRemoved, E.legacySuspendedGap), removed_membership: refused(E.fullscriptRemoved, E.fullscriptCallback),
      stale_token: refused(E.fullscriptRemoved, E.fullscriptNoClinic, E.fullscriptOutage),
      compromised_identity: refused(E.fullscriptOutage, E.fullscriptRemoved, E.revokedLogin) },
    database_current: { unapproved_account: refused(E.fullscriptNoClinic, E.fullscriptOtherAccount),
      suspended_clinic: refused(E.fullscriptRemoved, E.signInSuspended), removed_membership: refused(E.fullscriptRemoved, E.fullscriptCallback),
      stale_token: refused(E.fullscriptRemoved, E.fullscriptNoClinic, E.fullscriptOutage),
      compromised_identity: refused(E.fullscriptOutage, E.fullscriptRemoved, E.discoveryDisabled) },
  },
  campaigns: {
    description: 'The campaign engine (marketing; never clinical data)',
    upstream: 'campaign API (its own authorizer; practice from the token)',
    legacy_claims: { unapproved_account: refused(E.zeroAccessLegacy), suspended_clinic: { result: 'token_lifetime', reason: 'The campaign store has no clinic status; a practice is the token\'s claim until it expires.' },
      removed_membership: { result: 'token_lifetime', reason: 'No membership rows in the campaign store; the claim stands until the token expires.' },
      stale_token: { result: 'token_lifetime', reason: 'Claims-based by design.' },
      compromised_identity: REVOKED_CAMPAIGNS },
    database_current: { unapproved_account: refused(E.campaignIndependent), suspended_clinic: { result: 'token_lifetime', reason: 'Independent of clinical authority; as under legacy.' },
      removed_membership: { result: 'token_lifetime', reason: 'As under legacy.' }, stale_token: { result: 'token_lifetime', reason: 'As under legacy.' },
      compromised_identity: REVOKED_CAMPAIGNS },
  },
  applicant: {
    description: 'Applying to a clinic and the BLOCKED new-clinic bootstrap: an applicant has no clinic by definition',
    upstream: 'applicant API /clinical-core/workforce/{applications,clinic-bootstrap}',
    legacy_claims: { unapproved_account: na('This is the unapproved account\'s own door; it acts on the subject alone and never names a clinic.'),
      suspended_clinic: refused(E.bootstrapSuspended), removed_membership: na('No membership is exercised.'), stale_token: refused(E.applicantNoClinic),
      compromised_identity: { result: 'token_lifetime', reason: 'The applicant API checks the Cognito account (AdminGetUser: enabled and confirmed), not the clinical identity row, so a revoked login is refused here once the revocation\'s provider step disables the user, and admitted until then. It reaches no clinic data: a request to join waits for the clinic, and the bootstrap is BLOCKED.', evidence: [E.applicantCognito] } },
    database_current: { unapproved_account: na('As under legacy.'), suspended_clinic: refused(E.bootstrapSuspended),
      removed_membership: na('No membership is exercised.'), stale_token: refused(E.bootstrapBlocked),
      compromised_identity: { result: 'token_lifetime', reason: 'As under legacy: the Cognito account, not the identity row.', evidence: [E.applicantCognito] } },
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
  'live/labs/upload': 'transitional_lab_documents', 'live/labs/document/[documentId]': 'transitional_lab_documents',
  'live/scribe/chunk': 'transitional_scribe', 'live/scribe/consent': 'transitional_scribe', 'live/scribe/recording': 'transitional_scribe', 'live/scribe/transcript': 'transitional_scribe',
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
