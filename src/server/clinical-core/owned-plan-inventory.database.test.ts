import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createOwnedConsumerRecordsAdapter } from './owned-consumer-records';
import { createOwnedConsumerApi, type OwnedConsumerApiConfiguration } from './owned-consumer-api';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import type { ClinicalCoreDatabase } from './database';
import { catalogSha256, manifestContentForHash, productLabelContentForHash,
  validateGovernedCatalogManifest, type GovernedCatalogSeedManifest } from './aws-governed-catalog';
import { adoptedPlanInventorySchema } from '@/contracts/adoptedPlanInventory';

let pg: PGlite;
const org = randomUUID(), reviewer = randomUUID();
const unwrap = (p: unknown) => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p;
const driver = (role = false): ClinicalCoreDatabase => ({ transaction: work => pg.transaction(async tx => {
  if (role) await tx.exec('set local role clinical_core_api');
  return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) });
}) });
const adapter = createOwnedConsumerRecordsAdapter(driver(true));

beforeAll(async () => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 })) as { manifest: { migrations: { file: string }[] }; files: Record<string, string> };
  pg = new PGlite({ extensions: { pgcrypto } });
  for (const entry of artifact.manifest.migrations) await pg.exec(artifact.files[entry.file]);
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional inventory organization')", [org]);
  await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [reviewer, 'subject_' + reviewer.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [reviewer, 'fixture-' + reviewer]);
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,'owner','active')", [org, reviewer]);
  await pg.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
    values('protocols_supplements','inventory-fixture','FICTIONAL ONLY',encode(public.digest('FICTIONAL ONLY','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`);
}, 30000);
afterAll(async () => { await pg?.close(); });

async function owner() {
  const id = randomUUID();
  await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [id, 'fixture-' + id]);
  await pg.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',1,'granted','inventory-fixture')", [id]);
  return { actorPersonId: id, organizationId: org, identitySubject: 'fixture-' + id, identityPool: 'consumer', purpose: 'clinical_data',
    environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true } as ProductionClinicalRequestContext;
}
// All declarations and approvals are fictional local fixtures. This suite has
// no AWS transport, never signs real evidence and never deploys a candidate.
function catalog(key = randomUUID().replaceAll('-', ''), release = true): GovernedCatalogSeedManifest {
  const productBase = { stableId: 'prd_inventory_' + key, version: 1, displayName: 'Fictional full-label product',
    productType: 'supplement' as const, accessTier: 'open' as const, declaredRestricted: false, directOrderAllowed: true,
    clinicalPayload: { ingredients: ['Marketing highlight is NOT inventory'] }, sourceRefs: ['synthetic:full-label'] };
  const product = { ...productBase, contentSha256: catalogSha256(productBase) };
  const labelBase = { stableId: 'lbl_inventory_' + key, productStableId: product.stableId, version: 1,
    labelFound: true, physicalLabelRequired: false, substantiveConflict: false, practitionerDecisionRequired: false,
    labelPayload: { serving: 'Fictional measured serving', ingredients: ['Fictional A', 'Fictional B'] },
    crosscheckPayload: release ? { ingredientInventory: { contract: 'catalog-ingredient-release/1',
      productId: product.stableId, productVersion: 1, productContentSha256: product.contentSha256,
      labelId: 'lbl_inventory_' + key, labelVersion: 1,
      labelPayloadSha256: catalogSha256({ serving: 'Fictional measured serving', ingredients: ['Fictional A', 'Fictional B'] }),
      completeness: 'complete', sourceVerification: 'V', ingredientKeys: ['fictional-a', 'fictional-b'], sourceRefs: ['synthetic:full-label'] } } : {},
    sourceRefs: ['synthetic:full-label'] };
  const label = { ...labelBase, contentSha256: catalogSha256(productLabelContentForHash(labelBase)) };
  const base = { contractVersion: 'governed-catalog-seed/1' as const, sourcePackageId: 'synthetic.inventory.' + key,
    sourcePackageVersion: 1, targetEnvironment: 'production-clinical' as const, dataClassification: 'reference_only' as const,
    containsPhi: false as const, products: [product], productLabels: [label], commercialOffers: [], protocolTemplates: [], safetyRules: [], knowledgeSources: [] };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}
async function review(sql: string, params: unknown[]) {
  return driver(true).transaction(async tx => {
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [reviewer, org, 'fixture-' + reviewer]);
    return tx.query(sql, params);
  });
}
type TestCatalog = { products: {stableId: string}[]; productLabels: {stableId: string; crosscheckPayload: Record<string, unknown>}[] };
async function released(release = true, approved = true): Promise<TestCatalog> {
  const key = randomUUID().replaceAll('-', ''), id = randomUUID(), batch = randomUUID(), productId = 'prd_inventory_' + key;
  const productContentSha256 = catalogSha256({ fictional: key }), labelSha256 = catalogSha256({ fictionalLabel: key });
  await pg.query(`insert into clinical_reference.catalog_import_batches(id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
    values($1,'fixture/1',$2,'1',$3,'production-clinical','succeeded')`, [batch, 'fixture.' + key, catalogSha256({ batch })]);
  await pg.query(`insert into clinical_reference.catalog_products(stable_id,review_status,active_version,environment)
    values($1,$2,1,'production-clinical')`, [productId, approved ? 'approved' : 'needs_review']);
  await pg.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,access_tier,
    label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
    values($1,$2,1,'Fictional product','supplement','open',$3,$4,$5,$6,$7,$8)`,
    [id, productId, labelSha256, productContentSha256, { ingredients: ['Marketing highlight is NOT inventory'] }, ['synthetic:full-label'], approved ? 'approved' : 'needs_review', batch]);
  const assertion = { contract: 'production-catalog-ingredient-release/1', productId, productVersion: 1, productContentSha256,
    labelVersionId: id, labelSha256, completeness: 'complete', sourceVerification: 'V',
    ingredientKeys: ['fictional-a', 'fictional-b'], sourceRefs: ['synthetic:full-label'] };
  if (release) await review('select clinical_core.verify_product_ingredient_inventory($1,$2::jsonb)', [id, JSON.stringify(assertion)]);
  else await pg.query('insert into clinical_reference.product_label_verifications(product_version_id,reviewer_person_id,verification_note) values($1,$2,$3)',
    [id, reviewer, 'Fictional historical prose verification, NOT ingredient completeness.']);
  return { products: [{ stableId: productId }], productLabels: [{ stableId: id, crosscheckPayload: { ingredientInventory: assertion } }] };
}
async function write(context: ProductionClinicalRequestContext, payload: Record<string, unknown>, recordId = randomUUID(), revision = 1, deleted = false) {
  await pg.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
    values($1,'protocols',$2,$3,$4,$5,$6,$7,1)`, [context.actorPersonId, recordId, revision, randomUUID(), catalogSha256(payload), payload, deleted]);
  return recordId;
}
function plan(manifest: TestCatalog) {
  return { status: 'active', supplements_json: [{ id: 'fictional-item', status: 'active', dose: '1 fictional measured serving',
    governedProduct: { productId: manifest.products[0].stableId, labelVersionId: manifest.productLabels[0].stableId } }], peptides_json: [] };
}
async function adopted(payload: Record<string, unknown>) {
  const context = await owner(), recordId = await write(context, payload);
  await adapter.adoptActivePlan(context, { recordId, revision: 1, contentSha256: catalogSha256(payload), consentRevision: 1, requestId: randomUUID(), expectedPrevious: null });
  return { context, recordId };
}

describe('same-target adopted-plan inventory: real production and catalog SQL under API-role RLS', () => {
  it('reads only the adopted owner revision and complete separately approved label, never latest received plans', async () => {
    const manifest = await released(), payload = plan(manifest), f = await adopted(payload);
    await write(f.context, { status: 'active', supplements_json: [{ id: 'unadopted-unknown', status: 'active' }], peptides_json: [] });
    const result = await adapter.activePlanInventory(f.context);
    expect(adoptedPlanInventorySchema.parse(result)).toMatchObject({ inventoryComplete: true, incompleteReason: null,
      adoptedPlan: { recordId: f.recordId, revision: 1 }, coverage: 'adopted_plan_only', clinicalClearance: false });
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ productId: manifest.products[0].stableId, ingredientKeys: ['fictional-a', 'fictional-b'] });
    expect(result.products[0].ingredientReleaseSha256).toBe(catalogSha256(manifest.productLabels[0].crosscheckPayload.ingredientInventory));
    expect((await adapter.activePlanInventory(f.context)).inventoryRevision).toBe(result.inventoryRevision);
    expect(JSON.stringify(result)).not.toContain('Marketing highlight');
  });
  it('does not report no adopted plan as a verified empty inventory', async () => {
    const c = await owner();
    expect(await adapter.activePlanInventory(c)).toMatchObject({ adoptedPlan: null, inventoryComplete: false, incompleteReason: 'plan_not_adopted', products: [] });
  });
  it('accepts an explicitly empty adopted active plan, not absent arrays', async () => {
    const empty = await adopted({ status: 'active', supplements_json: [], peptides_json: [] });
    expect(await adapter.activePlanInventory(empty.context)).toMatchObject({ inventoryComplete: true, products: [] });
    const absent = await adopted({ status: 'active' });
    expect(await adapter.activePlanInventory(absent.context)).toMatchObject({ inventoryComplete: false, incompleteReason: 'plan_shape_unknown' });
  });
  it.each(['inactive', 'missing-status', 'missing-item-id', 'blank-item-id', 'missing-identity', 'missing-dose', 'missing-label-version', 'peptides', 'duplicate-item'])
    ('holds malformed or unresolvable adopted content: %s', async kind => {
      const manifest = await released(), payload = plan(manifest) as Record<string, unknown>;
      const entries = payload.supplements_json as Record<string, unknown>[];
      if (kind === 'inactive') payload.status = 'draft';
      if (kind === 'missing-status') delete entries[0].status;
      if (kind === 'missing-item-id') delete entries[0].id;
      if (kind === 'blank-item-id') entries[0].id = '   ';
      if (kind === 'missing-identity') delete entries[0].governedProduct;
      if (kind === 'missing-dose') delete entries[0].dose;
      if (kind === 'missing-label-version') (entries[0].governedProduct as Record<string, unknown>).labelVersionId = 'unversioned';
      if (kind === 'peptides') payload.peptides_json = [{ name: 'Fictional unresolved peptide' }];
      if (kind === 'duplicate-item') entries.push({ ...entries[0] });
      const f = await adopted(payload), result = await adapter.activePlanInventory(f.context);
      expect(result.inventoryComplete).toBe(false); expect(result.unresolved.length).toBeGreaterThan(0);
    });
  it('excludes explicit suggestions, never unknown-status entries', async () => {
    const f = await adopted({ status: 'active', supplements_json: [{ id: 'not-taking', status: 'suggested' }], peptides_json: [] });
    expect(await adapter.activePlanInventory(f.context)).toMatchObject({ inventoryComplete: true, products: [] });
  });
  it('holds marketing-only ingredient highlights and unreviewed imports', async () => {
    const old = await released(false), a = await adopted(plan(old));
    expect(await adapter.activePlanInventory(a.context)).toMatchObject({ inventoryComplete: false, incompleteReason: 'ingredients_unverified', products: [] });
    const pending = await released(true, false);
    const b = await adopted(plan(pending));
    expect(await adapter.activePlanInventory(b.context)).toMatchObject({ inventoryComplete: false, products: [] });
  });
  it.each(['product_version', 'product_label_version'] as const)('a withdrawn %s invalidates inventory and its revision', async subjectType => {
    const manifest = await released(), f = await adopted(plan(manifest)), before = await adapter.activePlanInventory(f.context);
    if (subjectType === 'product_version') await pg.query("update clinical_reference.catalog_products set review_status='rejected' where stable_id=$1", [manifest.products[0].stableId]);
    else await review('select clinical_core.withdraw_product_ingredient_inventory($1,$2)', [manifest.productLabels[0].stableId, 'Fictional verification superseded; full mapping held.']);
    const after = await adapter.activePlanInventory(f.context);
    expect(after).toMatchObject({ inventoryComplete: false, products: [], incompleteReason: 'ingredients_unverified' });
    expect(after.inventoryRevision).not.toBe(before.inventoryRevision);
  });
  it('rejects a stale adopted revision and a tombstone instead of silently switching to the latest plan', async () => {
    const f = await adopted({ status: 'active', supplements_json: [], peptides_json: [] });
    await write(f.context, { status: 'active', supplements_json: [], peptides_json: [], version: 2 }, f.recordId, 2);
    expect(await adapter.activePlanInventory(f.context)).toMatchObject({ inventoryComplete: false, incompleteReason: 'plan_changed', adoptedPlan: { revision: 1 } });
    await write(f.context, {}, f.recordId, 3, true);
    expect(await adapter.activePlanInventory(f.context)).toMatchObject({ inventoryComplete: false });
  });
  it('requires renewed adoption after consent withdrawal/regrant and refuses revoked access', async () => {
    const f = await adopted({ status: 'active', supplements_json: [], peptides_json: [] });
    await pg.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',2,'revoked','inventory-fixture')", [f.context.actorPersonId]);
    await expect(adapter.activePlanInventory(f.context)).rejects.toBeDefined();
    await pg.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',3,'granted','inventory-fixture')", [f.context.actorPersonId]);
    expect(await adapter.activePlanInventory(f.context)).toMatchObject({ inventoryComplete: false, incompleteReason: 'consent_changed' });
  });
  it('enforces real owner RLS and signed identity binding, without a caller-selectable owner', async () => {
    const manifest = await released(), a = await adopted(plan(manifest)), b = await owner();
    const result = await adapter.activePlanInventory(b);
    expect(result).toMatchObject({ ownerId: b.actorPersonId, adoptedPlan: null, products: [], inventoryComplete: false });
    expect(JSON.stringify(result)).not.toContain(a.recordId);
    await expect(adapter.activePlanInventory({ ...b, actorPersonId: a.context.actorPersonId })).rejects.toBeDefined();
  });
  it('a consumer cannot create or withdraw an ingredient approval, including by directly calling SQL', async () => {
    const manifest = await released(), c = await owner(), label = manifest.productLabels[0];
    const count = (await pg.query<{ n: number }>('select count(*)::int as n from clinical_reference.product_label_verifications')).rows[0].n;
    for (const [sql, args] of [
      ['select clinical_core.verify_product_ingredient_inventory($1,$2::jsonb)', [label.stableId, JSON.stringify(label.crosscheckPayload.ingredientInventory)]],
      ['select clinical_core.withdraw_product_ingredient_inventory($1,$2)', [label.stableId, 'forged consumer review']],
    ] as const) {
      await expect(driver(true).transaction(async tx => {
        await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'clinical_data','production-clinical','clinical_phi')", [c.actorPersonId, org, c.identitySubject]);
        return tx.query(sql, args);
      })).rejects.toBeDefined();
    }
    expect((await pg.query<{ n: number }>('select count(*)::int as n from clinical_reference.product_label_verifications')).rows[0].n).toBe(count);
  });
  it('a workforce practitioner without catalog-admin authority cannot sign full-ingredient verification', async () => {
    const manifest = await released(), label = manifest.productLabels[0];
    const before = (await pg.query<{ n: number }>('select count(*)::int as n from clinical_reference.product_label_verifications')).rows[0].n;
    await expect(pg.transaction(async tx => {
      await tx.query("update clinical_core.organization_memberships set role='practitioner' where organization_id=$1 and person_id=$2", [org, reviewer]);
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [reviewer, org, 'fixture-' + reviewer]);
      await tx.query('select clinical_core.verify_product_ingredient_inventory($1,$2::jsonb)', [label.stableId, JSON.stringify(label.crosscheckPayload.ingredientInventory)]);
    })).rejects.toBeDefined();
    expect((await pg.query<{ n: number }>('select count(*)::int as n from clinical_reference.product_label_verifications')).rows[0].n).toBe(before);
  });
  it.each(['R', 'missing-source', 'partial', 'duplicate-key', 'bad-key', 'wrong-product', 'wrong-version', 'wrong-label', 'wrong-label-hash', 'foreign-source', 'extra'])
    ('the actual SQL review gate refuses %s before writing any verification', async kind => {
      const manifest = await released(), label = manifest.productLabels[0];
      const release = structuredClone(label.crosscheckPayload.ingredientInventory) as Record<string, unknown>;
      if (kind === 'R') release.sourceVerification = 'R';
      if (kind === 'missing-source') delete release.sourceVerification;
      if (kind === 'partial') release.completeness = 'partial';
      if (kind === 'duplicate-key') release.ingredientKeys = ['fictional-a', 'fictional-a'];
      if (kind === 'bad-key') release.ingredientKeys = ['Unmapped ingredient'];
      if (kind === 'wrong-product') release.productId = 'prd_other_product';
      if (kind === 'wrong-version') release.productVersion = 2;
      if (kind === 'wrong-label') release.labelVersionId = randomUUID();
      if (kind === 'wrong-label-hash') release.labelSha256 = 'e'.repeat(64);
      if (kind === 'foreign-source') release.sourceRefs = ['synthetic:unlisted'];
      if (kind === 'extra') release.approvalOverride = true;
      const before = (await pg.query<{ n: number }>('select count(*)::int as n from clinical_reference.product_label_verifications')).rows[0].n;
      await expect(review('select clinical_core.verify_product_ingredient_inventory($1,$2::jsonb)', [label.stableId, JSON.stringify(release)])).rejects.toMatchObject({ message: 'ingredient_inventory_invalid' });
      expect((await pg.query<{ n: number }>('select count(*)::int as n from clinical_reference.product_label_verifications')).rows[0].n).toBe(before);
    });
  it('detects a corrupted adopted digest instead of trusting a pointer-shaped assertion', async () => {
    const f = await adopted({ status: 'active', supplements_json: [], peptides_json: [] });
    // Privileged corruption fixture, not a public operation.
    await pg.query('update clinical_core.owned_consumer_active_plans set content_sha256=$1 where owner_id=$2', ['b'.repeat(64), f.context.actorPersonId]);
    expect(await adapter.activePlanInventory(f.context)).toMatchObject({ inventoryComplete: false, incompleteReason: 'plan_changed', products: [] });
  });
  it('the actual API route refuses caller plan/catalog/owner overrides and remains blocked for production', async () => {
    const f = await adopted({ status: 'active', supplements_json: [], peptides_json: [] }), now = Date.now();
    const config: OwnedConsumerApiConfiguration = { consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/fixture', consumerAudience: '12345678901234567890',
      phiAllowed: false, activationState: 'blocked', allowedScopes: ['protocols_supplements'], qualification: { accountId: '588966314750', databaseName: 'clinical_core_qualification',
        reviewSha256: 'e'.repeat(64), identitySubjects: [f.context.identitySubject, 'fixture-other-identity'] } };
    const api = createOwnedConsumerApi({ configuration: config, adapter: () => adapter, now: () => now });
    const event = { routeKey: 'GET /clinical-core/consumer/personal/active-plan/inventory', queryStringParameters: {}, requestContext: { authorizer: { jwt: { claims: {
      iss: config.consumerIssuer, aud: config.consumerAudience, token_use: 'id', sub: f.context.identitySubject, email_verified: 'true',
      'custom:person_id': f.context.actorPersonId, 'custom:organization_id': org, 'custom:production_bound': 'true', exp: Math.floor(now / 1000) + 300, iat: Math.floor(now / 1000) - 1 } } } } };
    const response = await api(event); expect(response.statusCode).toBe(200);
    expect(response.headers['x-clinical-execution']).toBe('qualification'); expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body).data.inventoryComplete).toBe(true);
    for (const key of ['ownerId', 'protocols', 'catalog', 'inventoryComplete']) {
      expect((await api({ ...event, queryStringParameters: { [key]: 'forged' } })).statusCode).toBe(400);
    }
    expect((await createOwnedConsumerApi({ configuration: { ...config, qualification: undefined }, adapter: () => { throw new Error('must not access DB'); } })(event)).statusCode).toBe(503);
  });
});

describe('ingredient release import gate: negative assertions remain inert', () => {
  it.each(['R', 'missing-verification', 'partial', 'duplicate', 'bad-key', 'foreign-product', 'foreign-label', 'wrong-version', 'wrong-label-hash', 'unlisted-source', 'extra-field'])
    ('rejects a recomputed, self-consistent manifest with an invalid %s ingredient assertion', kind => {
      const manifest = catalog(), label = manifest.productLabels[0];
      const release = label.crosscheckPayload.ingredientInventory as Record<string, unknown>;
      if (kind === 'R') release.sourceVerification = 'R';
      if (kind === 'missing-verification') delete release.sourceVerification;
      if (kind === 'partial') release.completeness = 'partial';
      if (kind === 'duplicate') release.ingredientKeys = ['fictional-a', 'fictional-a'];
      if (kind === 'bad-key') release.ingredientKeys = ['Fictional A'];
      if (kind === 'foreign-product') release.productId = 'prd_other_product';
      if (kind === 'foreign-label') release.labelId = 'lbl_other_label';
      if (kind === 'wrong-version') release.productVersion = 2;
      if (kind === 'wrong-label-hash') release.labelPayloadSha256 = 'c'.repeat(64);
      if (kind === 'unlisted-source') release.sourceRefs = ['synthetic:unlisted'];
      if (kind === 'extra-field') release.approvalOverride = true;
      const { contentSha256: omitted, ...base } = label; void omitted;
      label.contentSha256 = catalogSha256(productLabelContentForHash(base));
      const { manifestSha256: oldHash, ...manifestBase } = manifest; void oldHash;
      manifest.manifestSha256 = catalogSha256(manifestContentForHash(manifestBase));
      expect(() => validateGovernedCatalogManifest(manifest)).toThrow('manifest_invalid');
    });
});
