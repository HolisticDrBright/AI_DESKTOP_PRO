import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { requestIdentity } from './lab-request-ledger';
export const LAB_INVENTORY_VERSION = 'lab-job-inventory/1';
export const LAB_INVENTORY_INDEX = 'LabOwnerInventory';
type Scope = { ownerSub: string; organizationId: string; personId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Cognito subjects are opaque identity keys: observed subjects are UUID-shaped
// but do not necessarily carry RFC UUID version/variant bits. Never normalize
// them or use this format check in place of verified claims and exact ownership.
const cognitoSubject = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = new Set(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing','completed','needs_review','failed']);
const fail = (): never => { throw new Error('lab_inventory_invalid'); };
export function inventoryStamp(scope: Scope, createdAt: string, pk: string) {
  if (!cognitoSubject.test(scope.ownerSub) || ![scope.organizationId,scope.personId].every(v => uuid.test(v))
    || !pk.startsWith('job#') || !uuid.test(pk.slice(4)) || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) fail();
  return { inventoryOwner: 'lab-owner#' + createHash('sha256').update(JSON.stringify([scope.ownerSub,scope.organizationId,scope.personId])).digest('hex'),
    inventoryOrder: createdAt + '#' + pk.slice(4) };
}
/** Inventory excludes clinical inputs/results, filenames, object keys and credentials. */
export function labRecoveryDescriptor(row: Record<string, unknown>, scope: Scope, now = Date.now()) {
  if (row.ownerSub !== scope.ownerSub || row.organizationId !== scope.organizationId || row.personId !== scope.personId) return null;
  if (typeof row.pk !== 'string' || typeof row.createdAt !== 'string' || !states.has(String(row.state))
    || !Number.isFinite(row.expiresAt) || Number(row.expiresAt) <= Math.floor(now / 1000)) return null;
  inventoryStamp(scope, row.createdAt, row.pk);
  if (Date.parse(row.createdAt) > now || !Number.isInteger(row.progressPercent)
    || Number(row.progressPercent) < 0 || Number(row.progressPercent) > 100) fail();
  const kind = Array.isArray(row.structuredBiomarkers) ? 'saved' : 'documents';
  if (row.sourcePanelSha256 !== undefined && (kind !== 'saved' || typeof row.sourcePanelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourcePanelSha256))) fail();
  const request = row.recoveryRequest as Record<string, unknown> | undefined;
  const requestInfo = request ? { ...requestIdentity({id:request.id,createdAt:request.createdAt}), kind } : undefined;
  if (request && request.kind !== kind) fail();
  const documents = Array.isArray(row.documents) ? row.documents as Record<string, unknown>[] : [];
  const manifestValid = documents.length > 0 && documents.length <= 30
    && documents.every(d => uuid.test(String(d.clientDocumentId)) && /^[A-Za-z0-9+/]{43}=$/.test(String(d.checksumSHA256))
      && Number.isInteger(d.byteSize) && Number(d.byteSize) > 0 && Number(d.byteSize) <= 25 * 1024 * 1024
      && ['application/pdf','image/jpeg','image/png'].includes(String(d.contentType)))
    && new Set(documents.map(d => d.clientDocumentId)).size === documents.length;
  const uploadManifest = manifestValid ? documents.map(d => ({
    clientDocumentId: String(d.clientDocumentId), checksumSHA256: String(d.checksumSHA256),
    byteSize: Number(d.byteSize), contentType: String(d.contentType),
  })) : undefined;
  const panelId = typeof row.panelId === 'string' && uuid.test(row.panelId) ? row.panelId : undefined;
  return { jobId: row.pk.slice(4), createdAt: row.createdAt, expiresAt: Number(row.expiresAt),
    state: String(row.state), progressPercent: Number(row.progressPercent), kind,
    canResume: (kind !== 'saved' || Boolean(panelId && requestInfo)) && (row.state !== 'awaiting_upload' || Boolean(uploadManifest)),
    ...(panelId ? {panelId} : {}), ...(requestInfo ? {request:requestInfo} : {}), ...(uploadManifest ? {uploadManifest} : {}),
    ...(typeof row.sourcePanelSha256 === 'string' ? {sourcePanelSha256:row.sourcePanelSha256} : {}) };
}
export async function listLabInventory(db: DynamoDBDocumentClient, table: string, scope: Scope, cursor?: string) {
  const owner = inventoryStamp(scope, '2000-01-01T00:00:00.000Z', 'job#00000000-0000-4000-8000-000000000001').inventoryOwner;
  const validateKey = (input: unknown) => {
    const key = input as Record<string, string>;
    if (!key || Object.keys(key).sort().join(',') !== 'inventoryOrder,inventoryOwner,pk'
      || key.inventoryOwner !== owner || typeof key.inventoryOrder !== 'string' || typeof key.pk !== 'string') fail();
    if (inventoryStamp(scope, key.inventoryOrder.slice(0,24), key.pk).inventoryOrder !== key.inventoryOrder) fail();
    return key;
  };
  let after: Record<string,string> | undefined;
  if (cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,600}$/.test(cursor)) fail();
    after = validateKey(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  }
  // GSI membership is eventual and never an authorization decision.
  const page = await db.send(new QueryCommand({
    TableName: table, IndexName: LAB_INVENTORY_INDEX,
    KeyConditionExpression: 'inventoryOwner = :owner', ExpressionAttributeValues: {':owner':owner},
    Limit: 20, ScanIndexForward: false, ...(after ? {ExclusiveStartKey:after} : {}),
  }));
  const rows = await Promise.all((page.Items ?? []).map(async key => {
    validateKey(key);
    const current = await db.send(new GetCommand({TableName:table, Key:{pk:key.pk}, ConsistentRead:true}));
    return current.Item ? labRecoveryDescriptor(current.Item, scope) : null;
  }));
  const nextCursor = page.LastEvaluatedKey ? Buffer.from(JSON.stringify(validateKey(page.LastEvaluatedKey))).toString('base64url') : null;
  return { contractVersion:LAB_INVENTORY_VERSION, jobs:rows.filter(row => row !== null), nextCursor };
}
