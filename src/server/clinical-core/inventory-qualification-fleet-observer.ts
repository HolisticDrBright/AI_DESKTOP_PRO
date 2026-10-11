if (typeof window !== 'undefined') throw Error('inventory fleet observation is server-only');
import { execFileSync } from 'node:child_process';
import { inventoryCanonical, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { prepareInventoryQualificationConfiguration } from './inventory-qualification-configuration';
import { observeInventoryFoundation } from './inventory-qualification-foundation-observer';
import { observeInventoryDatabaseDependency } from './inventory-qualification-database-dependency';
import { observeInventoryIdentityDependency } from './inventory-qualification-identity-dependency';
import { inventoryDatabaseIdentityReader } from './inventory-qualification-database-identity';
import { observeInventoryStackDeclarations } from './inventory-qualification-stack-observer';
import { observeInventoryCandidateServices } from './inventory-qualification-service-observer';
import { observeInventoryCodeVersion } from './inventory-qualification-code-observer';
import { observeInventorySharedApi } from './inventory-qualification-api-observer';
import { inventoryQualificationLedgerArtifact, inventoryQualificationLedgerReader } from './inventory-qualification-ledger';

/** Coordinates real read-only adapters, not supplied snapshots/reports. Two
 * full passes bracket all component windows; this detects ordinary drift, not
 * an atomic cross-service snapshot. It cannot certify runtime acceptance,
 * missing dependency qualifications, review approval, preservation or PHI.
 * No argument or environment variable can replace an observation with a pass. */
export async function observeInventoryQualificationFleet(args: string[]) {
  const prepared = prepareInventoryQualificationConfiguration(args, '--observe-fleet');
  try {
    const { source, artifacts, target, targetSha256 } = prepared, base = target.target;
    const candidateBytes = execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let migration: unknown;
    try { migration = JSON.parse(candidateBytes); } catch { return inventoryRefuse('inventory_ledger_artifact_refused'); }
    const migrationRows = inventoryQualificationLedgerArtifact(migration);
    const ledgerRead = inventoryQualificationLedgerReader(migrationRows), databaseIdentityRead = inventoryDatabaseIdentityReader(migrationRows);
    // Bind the customer key from every candidate that declares the shared
    // database credential. Conflicting keys are refused, never first-wins.
    const keys = [...new Set(target.candidates.map(c => c.parameters.SecretKmsKeyArn).filter(k => k !== undefined))];
    if (keys.length !== 1) return inventoryRefuse('fleet_database_key_binding_refused');
    const separated = target.contract === 'inventory-qualification-target/2', credentials = target.databaseCredentials;
    if (!['inventory-qualification-target/1', 'inventory-qualification-target/2'].includes(target.contract)
      || !separated && base.schemaVersion !== 'aws-clinical-core-qualification-target/3'
      || separated && (!credentials || base.schemaVersion !== 'aws-clinical-core-qualification-target/4'
      || !base.operatorDatabaseSecretArn || !base.runtimeCredentialReviewSha256
      || base.operatorDatabaseSecretArn === base.databaseSecretArn || credentials.apiSecretKmsKeyArn !== keys[0]))
      return inventoryRefuse('fleet_runtime_credential_binding_refused');
    // Historical /1 retains its meaning. /2 never falls back when operator
    // authority is absent; request candidates remain bound to the API secret.
    const operatorSecret = separated ? base.operatorDatabaseSecretArn! : base.databaseSecretArn;
    const foundationBinding = { foundationStackName: base.foundationStackName, databaseClusterArn: base.databaseClusterArn,
      databaseSecretArn: operatorSecret, apiId: base.apiId, apiOrigin: base.apiOrigin,
      artifactBucket: target.artifactBucket, exportBucket: base.exportBucket,
      ...(separated ? { runtimeCredentials: { apiSecretArn: base.databaseSecretArn,
        fullscriptWorkerSecretArn: credentials!.fullscriptWorkerDatabaseSecretArn, reviewSha256: base.runtimeCredentialReviewSha256! } } : {}) };
    const databaseBinding = { databaseClusterArn: base.databaseClusterArn, databaseSecretArn: operatorSecret,
      secretKmsKeyArn: separated ? credentials!.operatorSecretKmsKeyArn : keys[0],
      ...(separated ? { clusterKmsKeyArn: credentials!.clusterKmsKeyArn } : {}) };
    const ledgerBinding = { DatabaseName: base.databaseName, DatabaseClusterArn: base.databaseClusterArn, DatabaseSecretArn: operatorSecret };
    const identityBinding = { identity: target.identity, organizationId: target.organizationId,
      subjects: { consumer: base.identitySubjects.consumer, foreignConsumer: base.identitySubjects.foreignConsumer,
        workforce: base.identitySubjects.workforce } };
    prepared.assertUnchanged();
    const pass = async () => {
      prepared.assertUnchanged();
      const foundation = await observeInventoryFoundation(foundationBinding);
      const dependency = await observeInventoryDatabaseDependency(databaseBinding);
      const identity = await observeInventoryIdentityDependency(identityBinding);
      // The successor-only adapter reads every row inside a read-only
      // transaction and requires rollback. A known 106 parent is not a pass.
      const ledger = await ledgerRead(ledgerBinding);
      const databaseIdentity = await databaseIdentityRead({ database: ledgerBinding, organizationId: target.organizationId,
        subjects: identityBinding.subjects, cognitoPersonBindingsSha256: identity.personBindingsSha256 });
      const candidates = [];
      for (const c of target.candidates) {
        prepared.assertUnchanged();
        const a = artifacts.candidates.find(a => a.candidate === c.candidate);
        if (!a) return inventoryRefuse('fleet_artifact_binding_refused');
        const declaration = await observeInventoryStackDeclarations(c, a);
        const services = await observeInventoryCandidateServices(declaration.snapshot, c, a);
        const code = [];
        for (const p of c.packages) code.push(await observeInventoryCodeVersion(p, source.sourceCommit, c.candidate));
        candidates.push({ declaration, services, code });
      }
      const snapshots = Object.fromEntries(candidates.map(c => [c.declaration.candidate, c.declaration.snapshot]));
      const api = await observeInventorySharedApi(target, snapshots, foundation.foundationStackId, artifacts);
      prepared.assertUnchanged();
      return { foundation, dependency, identity, databaseIdentity, ledger, candidates, api };
    };
    const first = await pass(), final = await pass();
    if (inventoryCanonical(first) !== inventoryCanonical(final)) return inventoryRefuse('fleet_observation_changed');
    prepared.assertUnchanged();
    return { contract: separated ? 'inventory-qualification-fleet-observation/2' : 'inventory-qualification-fleet-observation/1', status: 'not_completed',
      observationScope: 'source_foundation_database_metadata_cognito_configuration_designated_synthetic_subjects_database_identity_authority_candidate_services_code_api_ledger',
      sourceCommit: source.sourceCommit, sourceInputSha256: source.sourceInputSha256, buildManifestSha256: artifacts.manifestSha256,
      targetSha256, observationSha256: inventorySha(inventoryCanonical(first)), passes: 2,
      candidates: first.candidates.length, packages: first.candidates.reduce((n, c) => n + c.code.length, 0),
      observedResourcePlane: true, successorLedgerObserved: true,
      identityConfigurationVerified: true, designatedSyntheticSubjectsVerified: true,
      databaseIdentityAuthorityVerified: true,
      runtimeCredentialsQualified: false,
      // Deliberately NOT a qualification/acceptance verdict. Remove a remaining
      // gate only after engineering an independent observation for that scope.
      identityDependenciesVerified: false, networkVerified: false, providerDependenciesVerified: false,
      liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false,
      remaining: ['runtime secret contents, effective login/grants, API/worker secret encryption and rotation qualification',
        'retention-service authority, real sign-in and network/external provider dependency observations',
        'real interrupted custody and preservation qualification', 'runtime hosted acceptance',
        'matched releases and physical devices', 'human reviews and provider/policy approvals'] };
  } finally { prepared.dispose(); }
}
