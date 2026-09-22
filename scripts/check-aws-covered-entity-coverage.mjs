import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A covered entity's information can only be destroyed if the schema says where it is. Every table the production
 * artifact creates must appear in the coverage manifest: carrying the organization, hanging off a table that does, or
 * retained for a stated reason. A table the manifest does not account for fails this check, which is what stops the
 * next one from being quietly forgotten. The recorded delete order is checked against the artifact's own foreign keys.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(root, "scripts", "build-aws-production-clinical-core.mjs")], { cwd: root, stdio: "inherit" });

const directory = path.join(root, "dist", "aws-clinical-core", "production-migrations");
const artifact = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
const sql = artifact.migrations.map((entry) => readFileSync(path.join(directory, entry.file), "utf8")).join("\n");
const coverage = JSON.parse(readFileSync(path.join(root, "infra", "aws-clinical-core", "covered-entity-coverage.json"), "utf8"));

const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };

assert(coverage.record === "covered-entity-coverage/1", "coverage manifest contract is invalid");
assert(Array.isArray(coverage.tables) && coverage.tables.length > 0, "coverage manifest lists no tables");

/** Every `create table <schema>.<name> ( … )` in the artifact, with its body. */
function createdTables(source) {
  const found = new Map();
  const pattern = /create table (?:if not exists )?([a-z_]+\.[a-z_]+)\s*\(/gi;
  let match;
  while ((match = pattern.exec(source))) {
    let depth = 0;
    let end = source.length;
    for (let index = pattern.lastIndex - 1; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    found.set(match[1], source.slice(pattern.lastIndex, end).replace(/\s+/g, " "));
  }
  return found;
}

const tables = createdTables(sql);
assert(tables.size > 150, `expected the artifact to create the full schema, saw ${tables.size} tables`);

const declared = new Map(coverage.tables.map((entry) => [entry.table, entry]));
for (const table of tables.keys()) assert(declared.has(table), `coverage manifest does not account for ${table}`);
for (const table of declared.keys()) assert(tables.has(table), `coverage manifest names ${table}, which the artifact does not create`);

const RETAINED = new Set(["global_reference", "curated_knowledge", "individual_account", "service_operations", "organization_shell"]);
const inScope = new Set([...declared.values()].filter((entry) => entry.scope !== "retained").map((entry) => entry.table));

const references = (body) => new Set([...body.matchAll(/references\s+([a-z_]+\.[a-z_]+)\s*\(/gi)].map((match) => match[1]));

for (const entry of coverage.tables) {
  const body = tables.get(entry.table) ?? "";
  if (entry.scope === "retained") {
    assert(RETAINED.has(entry.class), `${entry.table} has an unknown retained class`);
    assert(typeof entry.reason === "string" && entry.reason.trim().length >= 20, `${entry.table} is retained without a stated reason`);
    // A retained table may not point at deleted rows, or the destruction would leave the schema inconsistent.
    for (const parent of references(body)) {
      assert(!inScope.has(parent), `retained ${entry.table} references ${parent}, which the destruction deletes`);
    }
    continue;
  }
  if (entry.scope === "organization_column") {
    assert(new RegExp(`\\b${entry.column}\\b`).test(body), `${entry.table} has no ${entry.column} column`);
  } else if (entry.scope === "parent") {
    assert(new RegExp(`\\b${entry.column}\\b`).test(body), `${entry.table} has no ${entry.column} column`);
    assert(inScope.has(entry.parent), `${entry.table} hangs off ${entry.parent}, which is not deleted`);
    assert(references(body).has(entry.parent), `${entry.table}.${entry.column} does not reference ${entry.parent}`);
  } else {
    errors.push(`${entry.table} has an unknown scope`);
  }
  // The recorded order must name every in-scope table this one points at, so deletes never hit a live reference.
  const expected = [...references(body)].filter((parent) => inScope.has(parent) && parent !== entry.table).sort();
  const recorded = [...(entry.dependsOn ?? [])].sort();
  assert(JSON.stringify(expected) === JSON.stringify(recorded),
    `${entry.table} records ${JSON.stringify(recorded)} as its delete-order dependencies; the artifact says ${JSON.stringify(expected)}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  console.error(`Covered entity coverage check failed with ${errors.length} problem(s).`);
  process.exitCode = 1;
} else {
  const counts = coverage.tables.reduce((totals, entry) => ({ ...totals, [entry.scope]: (totals[entry.scope] ?? 0) + 1 }), {});
  console.log(`Covered entity coverage accounts for ${coverage.tables.length} tables (${JSON.stringify(counts)}).`);
}
