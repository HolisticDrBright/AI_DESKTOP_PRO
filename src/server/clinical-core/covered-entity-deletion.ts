if (typeof window !== "undefined") {
  throw new Error("clinical-core/covered-entity-deletion is server-only.");
}

import { createHash } from "node:crypto";

import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";

/**
 * Destroying one covered entity's information.
 *
 * When an agreement with a clinic ends, everything held on its behalf must be returned or destroyed, and saying so is
 * not the same as being able to do it. The hard part is not the deleting; it is knowing what the clinic's information
 * *is*, across a schema that keeps growing. So the answer is written down per table, in a coverage manifest that every
 * table must appear in: either it carries the organization, or it hangs off a table that does, or it is retained for a
 * stated reason. A build-time check refuses a schema whose tables the manifest does not account for, which is what
 * stops the next table from being quietly forgotten.
 *
 * Three classes are deliberately kept. Reviewed reference knowledge and catalog curation are shared with every other
 * organization and hold no individual's information. An individual's own account is theirs, not the clinic's: a person
 * may hold memberships in more than one organization, and their owned records are consumer-self-entered, so they are
 * removed by the individual deletion path instead. The organization row itself stays as a shell so the destruction
 * record remains readable. Every retained table says which of these it is and why, in the manifest.
 *
 * Nothing here certifies more than it did: object stores are destroyed by a purger the caller supplies, and a report
 * says plainly whether that happened.
 */
export const COVERED_ENTITY_COVERAGE_RECORD = "covered-entity-coverage/1" as const;
export const COVERED_ENTITY_DELETION_RECORD = "covered-entity-deletion/1" as const;

export const RETAINED_CLASSES = [
  "global_reference", "curated_knowledge", "individual_account", "service_operations", "organization_shell",
] as const;
export type RetainedClass = (typeof RETAINED_CLASSES)[number];

export type CoveredEntityCoverageEntry =
  | { table: string; scope: "organization_column"; column: string; objectKeyColumns?: string[]; dependsOn?: string[] }
  | { table: string; scope: "parent"; column: string; parent: string; parentColumn: string; objectKeyColumns?: string[]; dependsOn?: string[] }
  | { table: string; scope: "retained"; class: RetainedClass; reason: string };

export type CoveredEntityCoverage = {
  record: typeof COVERED_ENTITY_COVERAGE_RECORD;
  tables: CoveredEntityCoverageEntry[];
};

export type CoveredEntityDeletionCategory =
  | "coverage_malformed"
  | "organization_invalid"
  | "termination_unconfirmed"
  | "legal_hold_present"
  | "object_inventory_too_large"
  | "objects_not_purged"
  | "content_remains";

export class CoveredEntityDeletionError extends Error {
  readonly category: CoveredEntityDeletionCategory;
  constructor(category: CoveredEntityDeletionCategory, readonly table?: string) {
    super(category);
    this.name = "CoveredEntityDeletionError";
    this.category = category;
  }
}

const TABLE = /^[a-z_]{1,40}\.[a-z_]{1,63}$/;
const COLUMN = /^[a-z_]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^[A-Za-z0-9_:./-]{3,120}$/;
/** A chain longer than this is a manifest mistake, not a schema. */
const MAX_DEPTH = 8;

function malformed(): never {
  throw new CoveredEntityDeletionError("coverage_malformed");
}

/** Strict: a manifest that cannot be read cannot say what a clinic's information is, so nothing may run against it. */
export function parseCoveredEntityCoverage(value: unknown): CoveredEntityCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  const row = value as Record<string, unknown>;
  if (row.record !== COVERED_ENTITY_COVERAGE_RECORD || !Array.isArray(row.tables) || row.tables.length === 0) malformed();
  const entries: CoveredEntityCoverageEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of row.tables) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) malformed();
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.table !== "string" || !TABLE.test(entry.table) || seen.has(entry.table)) malformed();
    seen.add(entry.table);
    const dependsOn = entry.dependsOn === undefined ? undefined
      : Array.isArray(entry.dependsOn) && entry.dependsOn.every((name) => typeof name === "string" && TABLE.test(name))
        ? (entry.dependsOn as string[]) : malformed();
    const objectKeyColumns = entry.objectKeyColumns === undefined ? undefined
      : Array.isArray(entry.objectKeyColumns) && entry.objectKeyColumns.length > 0
        && entry.objectKeyColumns.every((name) => typeof name === "string" && COLUMN.test(name))
        ? (entry.objectKeyColumns as string[]) : malformed();
    if (entry.scope === "organization_column") {
      if (typeof entry.column !== "string" || !COLUMN.test(entry.column)) malformed();
      entries.push({ table: entry.table, scope: "organization_column", column: entry.column, ...(objectKeyColumns ? { objectKeyColumns } : {}), ...(dependsOn ? { dependsOn } : {}) });
    } else if (entry.scope === "parent") {
      if (typeof entry.column !== "string" || !COLUMN.test(entry.column)
        || typeof entry.parent !== "string" || !TABLE.test(entry.parent)
        || typeof entry.parentColumn !== "string" || !COLUMN.test(entry.parentColumn)) malformed();
      entries.push({ table: entry.table, scope: "parent", column: entry.column, parent: entry.parent, parentColumn: entry.parentColumn, ...(objectKeyColumns ? { objectKeyColumns } : {}), ...(dependsOn ? { dependsOn } : {}) });
    } else if (entry.scope === "retained") {
      if (typeof entry.class !== "string" || !(RETAINED_CLASSES as readonly string[]).includes(entry.class)
        || typeof entry.reason !== "string" || entry.reason.trim().length < 20) malformed();
      entries.push({ table: entry.table, scope: "retained", class: entry.class as RetainedClass, reason: entry.reason });
    } else malformed();
  }
  const coverage: CoveredEntityCoverage = { record: COVERED_ENTITY_COVERAGE_RECORD, tables: entries };
  // Every chain must end at a table that carries the organization, and every named table must exist in the manifest.
  const byName = new Map(entries.map((entry) => [entry.table, entry]));
  for (const entry of entries) {
    if (entry.scope === "retained") continue;
    for (const name of entry.dependsOn ?? []) {
      const dependency = byName.get(name);
      if (!dependency || dependency.scope === "retained") malformed();
    }
    let cursor = entry;
    for (let depth = 0; ; depth += 1) {
      if (depth > MAX_DEPTH) malformed();
      if (cursor.scope === "organization_column") break;
      if (cursor.scope !== "parent") malformed();
      const parent = byName.get(cursor.parent);
      if (!parent || parent.scope === "retained") malformed();
      cursor = parent;
    }
  }
  deletionOrder(coverage);
  return coverage;
}

/** Children before parents: a table is deleted only after everything that points at it. */
export function deletionOrder(coverage: CoveredEntityCoverage): string[] {
  const scoped = coverage.tables.filter((entry) => entry.scope !== "retained");
  const pointedAtBy = new Map<string, string[]>();
  for (const entry of scoped) {
    const references = new Set<string>(entry.scope === "parent" ? [entry.parent] : []);
    for (const name of entry.dependsOn ?? []) references.add(name);
    references.delete(entry.table);
    pointedAtBy.set(entry.table, [...references]);
  }
  // Everything that points at a table is emitted before it; a cycle cannot be deleted by plain statements at all.
  const dependentsOf = new Map<string, string[]>();
  for (const [table, references] of pointedAtBy) {
    for (const reference of references) dependentsOf.set(reference, [...(dependentsOf.get(reference) ?? []), table]);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  const walk = (table: string, open: Set<string>) => {
    if (placed.has(table)) return;
    if (open.has(table)) malformed();
    open.add(table);
    for (const dependent of dependentsOf.get(table) ?? []) walk(dependent, open);
    open.delete(table);
    placed.add(table);
    order.push(table);
  };
  for (const entry of scoped) walk(entry.table, new Set());
  return order;
}

/** `organization_id = $1`, or the same question asked of the parent this table hangs off. */
export function rowPredicate(table: string, coverage: CoveredEntityCoverage, depth = 0): string {
  if (depth > MAX_DEPTH) malformed();
  const entry = coverage.tables.find((candidate) => candidate.table === table);
  if (!entry || entry.scope === "retained") malformed();
  if (entry.scope === "organization_column") return `${table}.${entry.column} = $1`;
  return `${table}.${entry.column} in (select ${entry.parent}.${entry.parentColumn} from ${entry.parent} where ${rowPredicate(entry.parent, coverage, depth + 1)})`;
}

export function planCoveredEntityDeletion(coverage: CoveredEntityCoverage): Array<{ table: string; sql: string }> {
  return deletionOrder(coverage).map((table) => ({ table, sql: `delete from ${table} where ${rowPredicate(table, coverage)}` }));
}

export function planCoveredEntityVerification(coverage: CoveredEntityCoverage): Array<{ table: string; sql: string }> {
  return deletionOrder(coverage).map((table) => ({ table, sql: `select count(*)::int as remaining from ${table} where ${rowPredicate(table, coverage)}` }));
}

/** Object keys are read before any row is deleted, because a deleted row cannot tell you what it was pointing at. */
export function planCoveredEntityObjectInventory(coverage: CoveredEntityCoverage): Array<{ table: string; column: string; sql: string }> {
  const plans: Array<{ table: string; column: string; sql: string }> = [];
  for (const entry of coverage.tables) {
    if (entry.scope === "retained" || !entry.objectKeyColumns) continue;
    for (const column of entry.objectKeyColumns) {
      plans.push({
        table: entry.table,
        column,
        sql: `select ${entry.table}.${column} as object_key from ${entry.table} where ${rowPredicate(entry.table, coverage)} and ${entry.table}.${column} is not null order by ${entry.table}.${column}`,
      });
    }
  }
  return plans;
}

export type CoveredEntityObjectPurger = {
  purge(keys: string[]): Promise<{ purged: number; absent: number; failed: number }>;
};

export type CoveredEntityTermination = {
  /** The reference for the ended agreement. Never its text. */
  terminationReference: string;
  /** The operator's own confirmation that the agreement ended and destruction was decided. */
  confirmed: true;
};

export type CoveredEntityDeletionReport = {
  record: typeof COVERED_ENTITY_DELETION_RECORD;
  organizationId: string;
  terminationReference: string;
  deleted: Array<{ table: string; rows: number }>;
  retained: Array<{ class: RetainedClass; tables: number }>;
  objects: { inventoried: number; purged: number; absent: number; failed: number };
  certifies: { database: boolean; objectStores: boolean };
  evidenceSha256: string;
};

const HOLDS = `select count(*)::int as holds from clinical_private.owned_legal_holds h
where h.released_at is null and (
  exists (select 1 from clinical_core.organization_memberships m where m.person_id = h.owner_id and m.organization_id = $1)
  or exists (select 1 from clinical_core.patient_relationships r where r.recipient_person_id = h.owner_id and r.organization_id = $1))`;

async function holdsPresent(tx: ClinicalCoreTransaction, organizationId: string): Promise<boolean> {
  const result = await tx.query<{ holds: number }>(HOLDS, [clinicalUuid(organizationId)]);
  return Number(result.rows[0]?.holds ?? 0) > 0;
}

/** Read-only: what the clinic still holds, table by table, and how many stored objects hang off it. */
export async function inspectCoveredEntityContent(input: {
  database: ClinicalCoreDatabase;
  organizationId: string;
  coverage: CoveredEntityCoverage;
  objectKeyLimit?: number;
}): Promise<{ organizationId: string; rows: Array<{ table: string; rows: number }>; objects: number; holds: boolean }> {
  if (!UUID.test(input.organizationId)) throw new CoveredEntityDeletionError("organization_invalid");
  return input.database.transaction(async (tx) => {
    const rows: Array<{ table: string; rows: number }> = [];
    for (const step of planCoveredEntityVerification(input.coverage)) {
      const result = await tx.query<{ remaining: number }>(step.sql, [clinicalUuid(input.organizationId)]);
      const remaining = Number(result.rows[0]?.remaining ?? 0);
      if (remaining > 0) rows.push({ table: step.table, rows: remaining });
    }
    const keys = await inventoryObjectKeys(tx, input.organizationId, input.coverage, input.objectKeyLimit ?? 50_000);
    return { organizationId: input.organizationId, rows, objects: keys.length, holds: await holdsPresent(tx, input.organizationId) };
  });
}

async function inventoryObjectKeys(
  tx: ClinicalCoreTransaction,
  organizationId: string,
  coverage: CoveredEntityCoverage,
  limit: number,
): Promise<string[]> {
  const keys = new Set<string>();
  for (const step of planCoveredEntityObjectInventory(coverage)) {
    const result = await tx.query<{ object_key: string }>(step.sql, [clinicalUuid(organizationId)]);
    for (const row of result.rows) {
      if (typeof row.object_key === "string" && row.object_key.length > 0) keys.add(row.object_key);
      // Refuse rather than report a number the run cannot stand behind.
      if (keys.size > limit) throw new CoveredEntityDeletionError("object_inventory_too_large", step.table);
    }
  }
  return [...keys];
}

/**
 * Destroy one covered entity's information in one transaction. Object stores are purged first, from an inventory read
 * before any row is deleted, because a deleted row can no longer say what object it pointed at; a purge that does not
 * finish rolls the whole run back rather than leaving rows that claim objects still exist. Afterwards every in-scope
 * table is counted again and a non-zero count fails the run.
 */
export async function deleteCoveredEntityContent(input: {
  database: ClinicalCoreDatabase;
  organizationId: string;
  coverage: CoveredEntityCoverage;
  termination: CoveredEntityTermination;
  objects?: CoveredEntityObjectPurger;
  objectKeyLimit?: number;
}): Promise<CoveredEntityDeletionReport> {
  if (!UUID.test(input.organizationId)) throw new CoveredEntityDeletionError("organization_invalid");
  if (input.termination.confirmed !== true || !REFERENCE.test(input.termination.terminationReference)) {
    throw new CoveredEntityDeletionError("termination_unconfirmed");
  }
  const parameters = [clinicalUuid(input.organizationId)];
  return input.database.transaction(async (tx) => {
    if (await holdsPresent(tx, input.organizationId)) throw new CoveredEntityDeletionError("legal_hold_present");

    const keys = await inventoryObjectKeys(tx, input.organizationId, input.coverage, input.objectKeyLimit ?? 50_000);
    let objects = { inventoried: keys.length, purged: 0, absent: 0, failed: 0 };
    if (keys.length > 0 && input.objects) {
      const outcome = await input.objects.purge(keys);
      objects = { inventoried: keys.length, purged: outcome.purged, absent: outcome.absent, failed: outcome.failed };
      if (outcome.failed > 0 || outcome.purged + outcome.absent !== keys.length) {
        throw new CoveredEntityDeletionError("objects_not_purged");
      }
    }

    const deleted: Array<{ table: string; rows: number }> = [];
    for (const step of planCoveredEntityDeletion(input.coverage)) {
      const result = await tx.query(step.sql, parameters);
      const rows = Number(result.rowCount ?? 0);
      if (rows > 0) deleted.push({ table: step.table, rows });
    }
    for (const step of planCoveredEntityVerification(input.coverage)) {
      const result = await tx.query<{ remaining: number }>(step.sql, parameters);
      if (Number(result.rows[0]?.remaining ?? 0) > 0) throw new CoveredEntityDeletionError("content_remains", step.table);
    }

    const retained = RETAINED_CLASSES
      .map((name) => ({ class: name, tables: input.coverage.tables.filter((entry) => entry.scope === "retained" && entry.class === name).length }))
      .filter((row) => row.tables > 0);
    const certifies = { database: true, objectStores: keys.length === 0 || Boolean(input.objects) };
    return {
      record: COVERED_ENTITY_DELETION_RECORD,
      organizationId: input.organizationId,
      terminationReference: input.termination.terminationReference,
      deleted,
      retained,
      objects,
      certifies,
      evidenceSha256: createHash("sha256").update(JSON.stringify([
        COVERED_ENTITY_DELETION_RECORD, input.organizationId, input.termination.terminationReference, deleted, objects, certifies,
      ])).digest("hex"),
    };
  });
}
