import { assertItemId, assertPracticeId, type CampaignStore, type GlobalKind, type GlobalStore, type ItemKind, type PracticeStore, type PutOptions, type StoredItem, type TransactOp } from './store';

/**
 * The in-memory store: the same semantics as the DynamoDB store (versions, create-only puts, the due index,
 * bounded increments, all-or-nothing transactions, expiry), for tests and the local fixture. Fictional data only.
 */
type Row = StoredItem & { kind: string };

export function createMemoryCampaignStore(options: { now?: () => number } = {}): CampaignStore & { dump(): ReadonlyMap<string, Row> } {
  const rows = new Map<string, Row>();
  const now = options.now ?? (() => Date.now());
  const live = (row: Row | undefined) => row && (row.expiresAt == null || row.expiresAt * 1000 > now()) ? row : undefined;
  const clone = <T>(value: T): T => structuredClone(value);
  const out = <T>(row: Row): StoredItem<T> => ({ id: row.id, version: row.version, body: clone(row.body) as T, dueAt: row.dueAt ?? null, expiresAt: row.expiresAt ?? null });

  function space(prefix: string) {
    const key = (kind: string, id: string) => `${prefix}|${kind}|${assertItemId(id)}`;
    function check(op: TransactOp): boolean {
      const current = live(rows.get(key(op.kind, op.id)));
      if (op.op === 'put') return op.expected === null ? !current : current?.version === op.expected;
      if (op.op === 'delete') return current?.version === op.expected;
      const value = Number((current?.body as Record<string, unknown> | undefined)?.[op.field] ?? 0);
      return op.max === undefined || value + op.by <= op.max;
    }
    function apply(op: TransactOp) {
      const k = key(op.kind, op.id);
      const current = live(rows.get(k));
      if (op.op === 'put') { rows.set(k, { kind: op.kind, id: op.id, version: (current?.version ?? 0) + 1, body: clone(op.body), dueAt: op.dueAt ?? null, expiresAt: op.expiresAt ?? null }); return; }
      if (op.op === 'delete') { rows.delete(k); return; }
      const body = { ...((current?.body as Record<string, unknown>) ?? {}) };
      body[op.field] = Number(body[op.field] ?? 0) + op.by;
      rows.set(k, { kind: op.kind, id: op.id, version: (current?.version ?? 0) + 1, body, dueAt: current?.dueAt ?? null, expiresAt: current?.expiresAt ?? null });
    }
    return {
      async get<T>(kind: string, id: string) { const row = live(rows.get(key(kind, id))); return row ? out<T>(row) : null; },
      async put<T>(kind: string, id: string, body: T, options: PutOptions) {
        const op = { op: 'put' as const, kind: kind as ItemKind, id, body, expected: options.expected, dueAt: options.dueAt, expiresAt: options.expiresAt };
        if (!check(op)) return 'conflict' as const;
        apply(op); return 'ok' as const;
      },
      async delete(kind: string, id: string, expected: number) {
        const op = { op: 'delete' as const, kind: kind as ItemKind, id, expected };
        if (!check(op)) return 'conflict' as const;
        apply(op); return 'ok' as const;
      },
      async query<T>(kind: string, options: { prefix?: string; after?: string | null; limit?: number } = {}) {
        const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
        const head = `${prefix}|${kind}|`;
        const matching = [...rows.entries()].filter(([k, row]) => k.startsWith(head) && live(row) && (!options.prefix || row.id.startsWith(options.prefix)) && (!options.after || row.id > options.after))
          .map(([, row]) => row).sort((a, b) => (a.id < b.id ? -1 : 1));
        const page = matching.slice(0, limit);
        return { items: page.map(row => out<T>(row)), after: matching.length > limit ? page[page.length - 1]!.id : null };
      },
      async due<T>(kind: string, before: string, limit: number) {
        const head = `${prefix}|${kind}|`;
        return [...rows.entries()].filter(([k, row]) => k.startsWith(head) && live(row) && row.dueAt && row.dueAt <= before)
          .map(([, row]) => row).sort((a, b) => (a.dueAt! < b.dueAt! ? -1 : a.dueAt! > b.dueAt! ? 1 : a.id < b.id ? -1 : 1)).slice(0, limit).map(row => out<T>(row));
      },
      async increment(kind: string, id: string, field: string, by: number, max?: number) {
        const op = { op: 'increment' as const, kind: kind as ItemKind, id, field, by, max };
        if (!check(op)) return false;
        apply(op); return true;
      },
      async transact(ops: TransactOp[]) {
        if (!ops.every(check)) return false;
        for (const op of ops) apply(op);
        return true;
      },
    };
  }

  const practices = new Map<string, PracticeStore>();
  const global = space('G') as unknown as GlobalStore;
  return {
    practice(practiceId: string): PracticeStore {
      const id = assertPracticeId(practiceId);
      let handle = practices.get(id);
      if (!handle) { handle = Object.freeze({ practiceId: id, ...space(`P#${id}`) }) as unknown as PracticeStore; practices.set(id, handle); }
      return handle;
    },
    global: { ...global, async query<T>(kind: GlobalKind, options?: { after?: string | null; limit?: number }) { return (global.query as GlobalStore['query'])<T>(kind, options); } },
    dump: () => rows,
  };
}
