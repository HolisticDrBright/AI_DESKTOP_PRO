/** Exact independently compiled local SOURCE definitions. This is not an
 * Aurora profile, target admission, preserving writer or approval mechanism. */
import { createHash } from 'node:crypto';
import { buildClinicPreservingTransition, CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from './clinic-preserving-transition.mjs';
import { assertRestrictedSourceOwnerIdentity } from './telehealth-restricted-source-owner.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const refuse = () => { throw Error('clinic_source_definition_admission_refused'); };
const identityKeys = ['database_name', 'owner', 'session_owner', 'version', 'database_owner',
  'rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolinherit', 'rolbypassrls', 'rolcanlogin', 'rolreplication'];

export function assertClinicLocalSourcePrefix(artifact, pinnedReceipt, prefix, projection) {
  // Validate the independent receipt bytes and executable source before using
  // ANY of its expected digests. No expectation is learned from the observation.
  buildClinicPreservingTransition(artifact, pinnedReceipt);
  if (!Number.isSafeInteger(prefix) || prefix < 112 || prefix > 116) refuse();
  const expected = pinnedReceipt.snapshots[prefix - 112];
  if (!Array.isArray(projection) || canonical(projection) !== canonical(expected.projection)) refuse();
  return { contract: 'clinic-local-source-definitions/1', execution: 'local_restricted_owner_source',
    sourceOnly: true, migrationCount: prefix, projectedObjects: projection.length,
    sourceSchemaSha256: expected.schemaSha256, independentReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256,
    exactDefinitionsMatched: true, runtimeAdmission: false, managedRoleSemanticsVerified: false,
    custodyProven: false, upgradeAuthorized: false, providerAuthorized: false, phiAllowed: false, activation: 'blocked' };
}

export function assertClinicCompiledLocalSource(artifact, pinnedReceipt, compiled) {
  buildClinicPreservingTransition(artifact, pinnedReceipt);
  if (!compiled || typeof compiled !== 'object' || Array.isArray(compiled) || !compiled.ownerProfile) refuse();
  let identity;
  try { identity = assertRestrictedSourceOwnerIdentity([Object.fromEntries(identityKeys.map(key => [key, compiled.ownerProfile[key]]))]); }
  catch { return refuse(); }
  if (canonical(identity) !== canonical(compiled.ownerProfile)) refuse();
  // Only the compiler-generated disposable database nonce may differ between
  // source runs. Owners, grantors, memberships, ACLs, engine and every object
  // definition remain exact. A qualification/production database is refused.
  const expected = { ...pinnedReceipt, ownerProfile: { ...pinnedReceipt.ownerProfile, database_name: identity.database_name } };
  if (canonical(compiled) !== canonical(expected)) refuse();
  const prefixes = compiled.snapshots.map(snapshot => assertClinicLocalSourcePrefix(artifact, pinnedReceipt,
    snapshot.migrationCount, snapshot.projection));
  return { contract: 'clinic-compiled-local-source-admission/1', execution: 'local_restricted_owner_source',
    sourceOnly: true, exactDefinitionsMatched: true, checkedPrefixes: prefixes.map(row => row.migrationCount),
    independentReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256,
    compiledSchemaSha256: sha(JSON.stringify(compiled.snapshots.map(row => ({ migrationCount: row.migrationCount, schemaSha256: row.schemaSha256 })))),
    runtimeAdmission: false, managedRoleSemanticsVerified: false, custodyProven: false,
    upgradeAuthorized: false, providerAuthorized: false, phiAllowed: false, activation: 'blocked' };
}
