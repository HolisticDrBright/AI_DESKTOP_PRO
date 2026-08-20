import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const adaptersDir = path.join(root, "src", "adapters");
const migrationsDir = path.join(root, "supabase", "migrations");
const manifestPath = path.join(root, "infra", "aws-clinical-core", "desktop-compatibility-operations.json");
const outputPath = path.join(root, "infra", "aws-clinical-core", "desktop-operation-port-inventory.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const normalized = (value) => value.replace(/\s+/g, " ").trim();
const lineAt = (value, offset) => value.slice(0, offset).split("\n").length;

function literalNames(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [
    ...literalNames(node.whenTrue, sourceFile),
    ...literalNames(node.whenFalse, sourceFile),
  ];
  throw new Error(`dynamic operation name: ${node.getText(sourceFile)}`);
}

function adapterOperations() {
  const found = { rpc: new Map(), select: new Map() };
  for (const filename of fs.readdirSync(adaptersDir).filter((name) => name.endsWith(".live.ts")).sort()) {
    const fullPath = path.join(adaptersDir, filename);
    const source = fs.readFileSync(fullPath, "utf8");
    const sourceFile = ts.createSourceFile(fullPath, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ["clinicalRpc", "clinicalSelect"].includes(node.expression.text)) {
        const kind = node.expression.text === "clinicalRpc" ? "rpc" : "select";
        const first = node.arguments[0];
        if (!first) throw new Error(`${filename}: operation name missing`);
        const second = node.arguments[1];
        const argumentKeys = second && ts.isObjectLiteralExpression(second)
          ? second.properties.flatMap((property) => {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
            const name = property.name;
            return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? [name.text] : [];
          }).sort()
          : [];
        for (const name of literalNames(first, sourceFile)) {
          const uses = found[kind].get(name) ?? [];
          uses.push({
            adapter: filename,
            domain: filename.replace(/\.live\.ts$/, ""),
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            argumentKeys,
          });
          found[kind].set(name, uses);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

function matchingParen(sql, start) {
  let depth = 0;
  let single = false;
  for (let index = start; index < sql.length; index += 1) {
    const char = sql[index];
    if (single) {
      if (char === "'" && sql[index + 1] === "'") index += 1;
      else if (char === "'") single = false;
      continue;
    }
    if (char === "'") { single = true; continue; }
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return index;
  }
  throw new Error("unterminated function signature");
}

function functionDefinitions() {
  const definitions = new Map();
  const knownTables = new Set(createTableSources().keys());
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    const pattern = /create\s+(?:or\s+replace\s+)?function\s+(?:([a-z][a-z0-9_]*)\.)?([a-z][a-z0-9_]*)\s*\(/gi;
    for (const match of sql.matchAll(pattern)) {
      const start = match.index;
      const open = start + match[0].lastIndexOf("(");
      const close = matchingParen(sql, open);
      const after = sql.slice(close + 1);
      const asMatch = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(after);
      if (!asMatch || asMatch.index > 4000) throw new Error(`${filename}:${lineAt(sql, start)} function body delimiter missing`);
      const delimiter = asMatch[1];
      const bodyStart = close + 1 + asMatch.index + asMatch[0].length;
      const bodyEnd = sql.indexOf(delimiter, bodyStart);
      if (bodyEnd < 0) throw new Error(`${filename}:${lineAt(sql, start)} function body unterminated`);
      const semicolon = sql.indexOf(";", bodyEnd + delimiter.length);
      if (semicolon < 0) throw new Error(`${filename}:${lineAt(sql, start)} function terminator missing`);
      const name = match[2].toLowerCase();
      const schema = (match[1] ?? "public").toLowerCase();
      const signature = normalized(sql.slice(open + 1, close));
      const declaration = normalized(sql.slice(close + 1, close + 1 + asMatch.index));
      const body = sql.slice(bodyStart, bodyEnd);
      const full = sql.slice(start, semicolon + 1);
      const tableDependencies = [...new Set([...full.matchAll(
        /\b(?:from|join|insert\s+into|update|delete\s+from)\s+((?:[a-z][a-z0-9_]*\.)?[a-z][a-z0-9_]*)/gi,
      )].map((entry) => entry[1].toLowerCase()).filter((entry) => {
        const [candidateSchema, candidateName] = entry.includes(".") ? entry.split(".") : ["public", entry];
        return candidateSchema === "public" && knownTables.has(candidateName);
      }).map((entry) => entry.includes(".") ? entry : `public.${entry}`))].sort();
      const functionDependencies = [...new Set([...full.matchAll(
        /\b(?:perform|select)\s+((?:[a-z][a-z0-9_]*\.)?[a-z][a-z0-9_]*)\s*\(/gi,
      )].map((entry) => entry[1].toLowerCase()).filter((entry) => !entry.endsWith(`.${name}`) && entry !== name))].sort();
      const providerDependencies = {
        authUid: /\bauth\.uid\s*\(/i.test(full),
        authJwt: /\bauth\.jwt\s*\(/i.test(full),
        authUsers: /\bauth\.users\b/i.test(full),
        storage: /\bstorage\./i.test(full),
        realtime: /\brealtime\./i.test(full),
        vault: /\bvault\./i.test(full),
        networkExtension: /\b(?:net|pg_net)\./i.test(full),
      };
      const entry = {
        schema,
        signature,
        declaration,
        source: `supabase/migrations/${filename}`,
        line: lineAt(sql, start),
        sha256: sha256(full),
        tableDependencies,
        functionDependencies,
        providerDependencies,
      };
      const key = `${schema}.${name}(${signature})`;
      definitions.set(key, { name, entry });
    }
  }
  const byName = new Map();
  for (const { name, entry } of definitions.values()) {
    const entries = byName.get(name) ?? [];
    entries.push(entry);
    byName.set(name, entries);
  }
  for (const entries of byName.values()) entries.sort((a, b) => `${a.signature}|${a.source}`.localeCompare(`${b.signature}|${b.source}`));
  return byName;
}

function createTableSources() {
  const tables = new Map();
  for (const filename of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z][a-z0-9_]*)\s*\(/gi)) {
      tables.set(match[1].toLowerCase(), { source: `supabase/migrations/${filename}`, line: lineAt(sql, match.index) });
    }
  }
  return tables;
}

export function buildDesktopOperationInventory() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const calls = adapterOperations();
  const definitions = functionDefinitions();
  const tableSources = createTableSources();
  const nativeSynthetic = new Set(["rpc:list_patient_lab_observations", "select:patient_profiles", "select:lab_documents"]);
  const operations = [];
  for (const kind of ["rpc", "select"]) {
    for (const name of manifest.operations[kind]) {
      const uses = calls[kind].get(name) ?? [];
      const legacyDefinitions = kind === "rpc" ? (definitions.get(name) ?? []) : [];
      operations.push({
        kind,
        name,
        domains: [...new Set(uses.map((use) => use.domain))].sort(),
        callSites: uses,
        legacyDefinitions,
        ...(kind === "select" ? { legacyTableSource: tableSources.get(name) ?? null } : {}),
        syntheticBoundary: nativeSynthetic.has(`${kind}:${name}`) ? "native_aws" : "registry_disabled",
        productionStatus: "not_ported",
      });
    }
  }
  const allDefinitionHashes = operations.flatMap((operation) => operation.legacyDefinitions.map((definition) => definition.sha256));
  return {
    schemaVersion: "desktop-operation-port-inventory/1",
    generatedFrom: {
      operationManifestSha256: sha256(fs.readFileSync(manifestPath)),
      legacyDefinitionSetSha256: sha256(allDefinitionHashes.sort().join("\n")),
    },
    counts: {
      rpc: manifest.operations.rpc.length,
      select: manifest.operations.select.length,
      total: operations.length,
      productionPorted: operations.filter((operation) => operation.productionStatus === "ported").length,
    },
    operations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"))) {
  if (!process.argv.includes("--write")) {
    console.error("Pass --write to replace the committed operation inventory.");
    process.exit(1);
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(buildDesktopOperationInventory(), null, 2)}\n`);
  console.log(`Wrote ${path.relative(root, outputPath)}.`);
}
