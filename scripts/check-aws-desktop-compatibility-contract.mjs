import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const adaptersDir = path.join(root, "src", "adapters");
const migrationsDir = path.join(root, "supabase", "migrations");
const manifestPath = path.join(
  root,
  "infra",
  "aws-clinical-core",
  "desktop-compatibility-operations.json",
);

function fail(message) {
  console.error(`[aws-desktop-compatibility] FAIL — ${message}`);
  process.exitCode = 1;
}

function literalNames(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [
      ...literalNames(node.whenTrue, sourceFile),
      ...literalNames(node.whenFalse, sourceFile),
    ];
  }
  fail(`operation name must be a string literal or a conditional of string literals: ${node.getText(sourceFile)}`);
  return [];
}

function sourceOperations() {
  const found = { rpc: new Set(), select: new Set() };
  const files = fs.readdirSync(adaptersDir)
    .filter((name) => name.endsWith(".live.ts"))
    .sort();

  for (const name of files) {
    const filename = path.join(adaptersDir, name);
    const source = fs.readFileSync(filename, "utf8");
    const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && ["clinicalRpc", "clinicalSelect"].includes(node.expression.text)
      ) {
        const first = node.arguments[0];
        if (!first) {
          fail(`${name} contains ${node.expression.text} without an operation name`);
        } else {
          const kind = node.expression.text === "clinicalRpc" ? "rpc" : "select";
          for (const operation of literalNames(first, sourceFile)) found[kind].add(operation);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return Object.fromEntries(
    Object.entries(found).map(([kind, names]) => [kind, [...names].sort()]),
  );
}

function assertReviewedList(kind, value) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    fail(`manifest operations.${kind} must be a string array`);
    return [];
  }
  const canonical = [...new Set(value)].sort();
  if (JSON.stringify(value) !== JSON.stringify(canonical)) {
    fail(`manifest operations.${kind} must be sorted and duplicate-free`);
  }
  for (const name of value) {
    if (!/^[a-z][a-z0-9_]{1,127}$/.test(name)) fail(`invalid ${kind} operation name: ${name}`);
  }
  return canonical;
}

function compare(kind, expected, actual) {
  const missing = actual.filter((name) => !expected.includes(name));
  const stale = expected.filter((name) => !actual.includes(name));
  if (missing.length) fail(`unreviewed ${kind} operations used by Desktop: ${missing.join(", ")}`);
  if (stale.length) fail(`stale ${kind} operations no longer used by Desktop: ${stale.join(", ")}`);
}

function legacyFunctionDefinitions() {
  const names = new Set();
  for (const filename of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    for (const match of sql.matchAll(
      /create\s+or\s+replace\s+function\s+(?:public\.)?([a-z][a-z0-9_]*)\s*\(/gi,
    )) names.add(match[1].toLowerCase());
  }
  return names;
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`cannot read operation manifest: ${error instanceof Error ? error.message : "invalid JSON"}`);
  process.exit();
}

if (manifest.schemaVersion !== "desktop-aws-compatibility/1") {
  fail("manifest schemaVersion must be desktop-aws-compatibility/1");
}
if (manifest.authorization !== "cognito-workforce-membership-required") {
  fail("manifest authorization boundary is missing or invalid");
}

const reviewed = {
  rpc: assertReviewedList("rpc", manifest.operations?.rpc),
  select: assertReviewedList("select", manifest.operations?.select),
};
const actual = sourceOperations();
compare("rpc", reviewed.rpc, actual.rpc);
compare("select", reviewed.select, actual.select);

const legacyFunctions = legacyFunctionDefinitions();
const undefinedRpc = reviewed.rpc.filter((name) => !legacyFunctions.has(name));
if (undefinedRpc.length) {
  fail(`RPCs have no authored PostgreSQL function in the migration history: ${undefinedRpc.join(", ")}`);
}

if (!process.exitCode) {
  console.log(
    `[aws-desktop-compatibility] PASS — ${reviewed.rpc.length} RPCs and ${reviewed.select.length} `
      + "read models are explicitly reviewed; every RPC has an authored PostgreSQL definition.",
  );
}
