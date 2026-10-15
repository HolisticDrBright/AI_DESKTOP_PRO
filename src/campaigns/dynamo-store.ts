import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assertItemId, assertPracticeId, type CampaignStore, type GlobalKind, type GlobalStore, type PracticeStore, type PutOptions, type StoredItem, type TransactOp } from './store';

/**
 * The campaign store on its own DynamoDB table (`infra/campaigns/campaign-engine.json`), never a clinical store.
 *
 *   PK  `P#<practice id>` for every practice-scoped item, `G` for the few global ones
 *   SK  `<kind>#<id>`
 *   v   the item's version; body the item; n_<field> counters; ttl (epoch seconds) for expiring items
 *   duePK `P#<practice id>#<kind>` and dueAt: the sparse `due` index, present only while an item is due
 *
 * A practice handle builds its PK once from the practice id it was given, so no call it makes can address another
 * practice. Expired items (TTL deletes lazily) are treated as absent by every read and condition.
 */
type Item = { PK: string; SK: string; v: number; body?: unknown; dueAt?: string; duePK?: string; ttl?: number; [counter: `n_${string}`]: number };
const FIELD = /^[a-z_]{1,40}$/;

export function createDynamoCampaignStore(input: { client: Pick<DynamoDBDocumentClient, 'send'>; tableName: string; now?: () => number }): CampaignStore {
  const { client, tableName: TableName } = input;
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(TableName)) throw new Error('campaign_table_invalid');
  const nowSeconds = () => Math.floor((input.now?.() ?? Date.now()) / 1000);
  const notExpired = '(attribute_not_exists(#ttl) OR #ttl > :now)';

  function toStored<T>(item: Item | undefined, kind: string): StoredItem<T> | null {
    if (!item || (item.ttl !== undefined && item.ttl <= nowSeconds())) return null;
    const counters = Object.fromEntries(Object.entries(item).filter(([k]) => k.startsWith('n_')).map(([k, v]) => [k.slice(2), v]));
    const body = (item.body === undefined ? counters : Object.keys(counters).length ? { ...(item.body as object), ...counters } : item.body) as T;
    return { id: item.SK.slice(kind.length + 1), version: item.v ?? 0, body, dueAt: item.dueAt ?? null, expiresAt: item.ttl ?? null };
  }

  function space(PK: string) {
    const SK = (kind: string, id: string) => `${kind}#${assertItemId(id)}`;
    const putItem = (kind: string, id: string, body: unknown, version: number, options: Pick<PutOptions, 'dueAt' | 'expiresAt'>): Item => ({
      PK, SK: SK(kind, id), v: version, body,
      ...(options.dueAt ? { dueAt: options.dueAt, duePK: `${PK}#${kind}` } : {}), ...(options.expiresAt ? { ttl: options.expiresAt } : {}),
    });
    const putCondition = (expected: number | null) => expected === null
      ? { ConditionExpression: `attribute_not_exists(PK) OR (attribute_exists(#ttl) AND #ttl <= :now)`, ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':now': nowSeconds() } }
      : { ConditionExpression: `v = :expected AND ${notExpired}`, ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':expected': expected, ':now': nowSeconds() } };
    async function currentVersion(kind: string, id: string): Promise<number> {
      const got = await client.send(new GetCommand({ TableName, Key: { PK, SK: SK(kind, id) }, ConsistentRead: true }));
      const item = got.Item as Item | undefined;
      return item && !(item.ttl !== undefined && item.ttl <= nowSeconds()) ? item.v ?? 0 : 0;
    }
    const conditionFailed = (error: unknown) => ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes((error as { name?: string }).name ?? '');
    function incrementUpdate(kind: string, id: string, field: string, by: number, max?: number) {
      if (!FIELD.test(field) || !Number.isInteger(by)) throw new Error('increment_invalid');
      const limited = max !== undefined;
      return {
        Key: { PK, SK: SK(kind, id) },
        UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :by, v = if_not_exists(v, :zero) + :one',
        ...(limited ? { ConditionExpression: 'attribute_not_exists(#n) OR #n <= :limit' } : {}),
        ExpressionAttributeNames: { '#n': `n_${field}` },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':by': by, ...(limited ? { ':limit': max - by } : {}) },
      };
    }
    return {
      async get<T>(kind: string, id: string) {
        const got = await client.send(new GetCommand({ TableName, Key: { PK, SK: SK(kind, id) }, ConsistentRead: true }));
        return toStored<T>(got.Item as Item | undefined, kind);
      },
      async put<T>(kind: string, id: string, body: T, options: PutOptions) {
        const version = options.expected === null ? 1 : options.expected + 1;
        try { await client.send(new PutCommand({ TableName, Item: putItem(kind, id, body, version, options), ...putCondition(options.expected) })); return 'ok' as const; }
        catch (error) { if (conditionFailed(error)) return 'conflict' as const; throw error; }
      },
      async delete(kind: string, id: string, expected: number) {
        try { await client.send(new DeleteCommand({ TableName, Key: { PK, SK: SK(kind, id) }, ConditionExpression: 'v = :expected', ExpressionAttributeValues: { ':expected': expected } })); return 'ok' as const; }
        catch (error) { if (conditionFailed(error)) return 'conflict' as const; throw error; }
      },
      async query<T>(kind: string, options: { prefix?: string; after?: string | null; limit?: number } = {}) {
        const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
        const result = await client.send(new QueryCommand({ TableName, ConsistentRead: true, Limit: limit,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': PK, ':prefix': `${kind}#${options.prefix ?? ''}` },
          ...(options.after ? { ExclusiveStartKey: { PK, SK: SK(kind, options.after) } } : {}) }));
        const items = (result.Items as Item[] | undefined ?? []).map(item => toStored<T>(item, kind)).filter((x): x is StoredItem<T> => x !== null);
        const last = result.LastEvaluatedKey as { SK?: string } | undefined;
        return { items, after: last?.SK ? last.SK.slice(kind.length + 1) : null };
      },
      async due<T>(kind: string, before: string, limit: number) {
        const result = await client.send(new QueryCommand({ TableName, IndexName: 'due', Limit: Math.min(Math.max(limit, 1), 500),
          KeyConditionExpression: 'duePK = :due AND dueAt <= :before', ExpressionAttributeValues: { ':due': `${PK}#${kind}`, ':before': before } }));
        return (result.Items as Item[] | undefined ?? []).map(item => toStored<T>(item, kind)).filter((x): x is StoredItem<T> => x !== null);
      },
      async increment(kind: string, id: string, field: string, by: number, max?: number) {
        if (max !== undefined && by > max) return false;
        try { await client.send(new UpdateCommand({ TableName, ...incrementUpdate(kind, id, field, by, max) })); return true; }
        catch (error) { if (conditionFailed(error)) return false; throw error; }
      },
      async transact(ops: TransactOp[]) {
        if (ops.some(op => op.op === 'increment' && op.max !== undefined && op.by > op.max)) return false;
        const items = await Promise.all(ops.map(async op => {
          if (op.op === 'put') {
            const version = op.expected === null ? 1 : op.expected + 1;
            return { Put: { TableName, Item: putItem(op.kind, op.id, op.body, version, op), ...putCondition(op.expected) } };
          }
          if (op.op === 'delete') return { Delete: { TableName, Key: { PK, SK: SK(op.kind, op.id) }, ConditionExpression: 'v = :expected', ExpressionAttributeValues: { ':expected': op.expected } } };
          return { Update: { TableName, ...incrementUpdate(op.kind, op.id, op.field, op.by, op.max) } };
        }));
        try { await client.send(new TransactWriteCommand({ TransactItems: items })); return true; }
        catch (error) { if (conditionFailed(error)) return false; throw error; }
      },
      currentVersion,
    };
  }

  const handles = new Map<string, PracticeStore>();
  const g = space('G');
  const global: GlobalStore = {
    get: <T>(kind: GlobalKind, id: string) => g.get<T>(kind, id),
    put: <T>(kind: GlobalKind, id: string, body: T, options: PutOptions) => g.put<T>(kind, id, body, options),
    delete: (kind: GlobalKind, id: string, expected: number) => g.delete(kind, id, expected),
    query: <T>(kind: GlobalKind, options?: { after?: string | null; limit?: number }) => g.query<T>(kind, options),
  };
  return {
    practice(practiceId: string): PracticeStore {
      const id = assertPracticeId(practiceId);
      let handle = handles.get(id);
      if (!handle) {
        const s = space(`P#${id}`);
        handle = Object.freeze({ practiceId: id, get: s.get, put: s.put, delete: s.delete, query: s.query, due: s.due, increment: s.increment, transact: s.transact }) as PracticeStore;
        handles.set(id, handle);
      }
      return handle;
    },
    global,
  };
}
