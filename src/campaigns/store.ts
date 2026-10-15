/**
 * The campaign engine's commercial-side store, as a port with two implementations: an in-memory one for tests and
 * fixtures (`memory-store.ts`) and DynamoDB (`dynamo-store.ts`, its own table, never a clinical store).
 *
 * **Practice separation is structural.** Every practice-scoped read and write goes through `store.practice(id)`,
 * a handle that has no way to name another practice: there is no method on it that takes a practice id. The
 * handful of global records (the slug index, the allowances data, the list of practices holding the marketing
 * entitlement) are on `store.global`, which holds no contact, template, result or setting.
 *
 * Items are versioned. `put` with `expected: null` creates only; with a number it replaces only that version.
 */
export type ItemKind =
  | 'settings' | 'entitlement' | 'domain' | 'grant' | 'template' | 'sequence' | 'broadcast'
  | 'contact' | 'address' | 'send' | 'suppression' | 'result' | 'counter' | 'rate';
export type GlobalKind = 'slug' | 'allowances' | 'marketing_practice';

export type StoredItem<T = unknown> = { id: string; version: number; body: T; dueAt?: string | null; expiresAt?: number | null };
export type PutOptions = { expected: number | null; dueAt?: string | null; expiresAt?: number | null };
export type PutResult = 'ok' | 'conflict';

/** One item change inside an all-or-nothing write. */
export type TransactOp =
  | { op: 'put'; kind: ItemKind; id: string; body: unknown; expected: number | null; dueAt?: string | null; expiresAt?: number | null }
  | { op: 'increment'; kind: ItemKind; id: string; field: string; by: number; max?: number }
  | { op: 'delete'; kind: ItemKind; id: string; expected: number };

export interface PracticeStore {
  readonly practiceId: string;
  get<T>(kind: ItemKind, id: string): Promise<StoredItem<T> | null>;
  put<T>(kind: ItemKind, id: string, body: T, options: PutOptions): Promise<PutResult>;
  delete(kind: ItemKind, id: string, expected: number): Promise<PutResult>;
  /** Items of one kind whose id starts with `prefix`, in id order, one page at a time. */
  query<T>(kind: ItemKind, options?: { prefix?: string; after?: string | null; limit?: number }): Promise<{ items: StoredItem<T>[]; after: string | null }>;
  /** Items of one kind with a `dueAt` at or before `before`, oldest first (the sparse due index). */
  due<T>(kind: ItemKind, before: string, limit: number): Promise<StoredItem<T>[]>;
  /** Adds `by` to a numeric field; refuses (returns false) when the result would pass `max`. */
  increment(kind: ItemKind, id: string, field: string, by: number, max?: number): Promise<boolean>;
  /** All or nothing. False when any condition fails; nothing is written then. */
  transact(ops: TransactOp[]): Promise<boolean>;
}
export interface GlobalStore {
  get<T>(kind: GlobalKind, id: string): Promise<StoredItem<T> | null>;
  put<T>(kind: GlobalKind, id: string, body: T, options: PutOptions): Promise<PutResult>;
  delete(kind: GlobalKind, id: string, expected: number): Promise<PutResult>;
  query<T>(kind: GlobalKind, options?: { after?: string | null; limit?: number }): Promise<{ items: StoredItem<T>[]; after: string | null }>;
}
export interface CampaignStore {
  practice(practiceId: string): PracticeStore;
  readonly global: GlobalStore;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A practice is an organization id. Anything else is refused before any read or write. */
export function assertPracticeId(practiceId: string): string {
  if (!UUID.test(practiceId)) throw new Error('practice_id_invalid');
  return practiceId.toLowerCase();
}
const ITEM_ID = /^[A-Za-z0-9:._@-]{1,300}$/;
export function assertItemId(id: string): string {
  if (!ITEM_ID.test(id)) throw new Error('item_id_invalid');
  return id;
}
