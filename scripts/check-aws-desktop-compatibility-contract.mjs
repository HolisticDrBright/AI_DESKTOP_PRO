import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
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
const productionManifestPath = path.join(
  root,
  "infra",
  "aws-clinical-core",
  "desktop-production-operations.json",
);
const blockedCandidateDir = path.join(root, "infra", "aws-clinical-core", "production-candidates");

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

function blockedCandidateNames(value, productionNativeRpc) {
  if (!Array.isArray(value)) {
    fail("blockedCandidateRpcs must be an explicit array");
    return [];
  }
  const names = [];
  for (const entry of value) {
    if (!entry || typeof entry.name !== "string" || !/^[a-z][a-z0-9_]{1,127}$/.test(entry.name)
      || typeof entry.source !== "string" || typeof entry.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || entry.activation !== "blocked"
      || entry.featureFlag !== "CLINICAL_EMR_SAVE_RECEIPT_ENABLED") {
      fail("blocked candidate RPC entry is malformed or not explicitly disabled");
      continue;
    }
    const candidatePath = path.resolve(root, entry.source);
    if (path.dirname(candidatePath) !== blockedCandidateDir || !fs.existsSync(candidatePath)) {
      fail(`blocked candidate ${entry.name} must use a source in production-candidates`);
      continue;
    }
    const bytes = fs.readFileSync(candidatePath);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      fail(`blocked candidate ${entry.name} source digest changed`);
      continue;
    }
    const sql = bytes.toString("utf8");
    if (!new RegExp(`create\\s+or\\s+replace\\s+function\\s+clinical_core\\.${entry.name}\\s*\\(`, "i").test(sql)) {
      fail(`blocked candidate ${entry.name} has no matching SQL function`);
      continue;
    }
    if (productionNativeRpc.has(entry.name)) {
      fail(`blocked candidate ${entry.name} is already marked production-native`);
      continue;
    }
    const productionSqlDir = path.join(root, "infra", "aws-clinical-core", "production-migrations");
    if (fs.readdirSync(productionSqlDir).some(filename => filename.endsWith(".sql")
      && new RegExp(`create\\s+or\\s+replace\\s+function\\s+clinical_core\\.${entry.name}\\s*\\(`, "i")
        .test(fs.readFileSync(path.join(productionSqlDir, filename), "utf8")))) {
      fail(`blocked candidate ${entry.name} is already in a production migration`);
      continue;
    }
    names.push(entry.name);
  }
  const canonical = [...new Set(names)].sort();
  if (JSON.stringify(names) !== JSON.stringify(canonical)) {
    fail("blocked candidate RPCs must be sorted and duplicate-free");
  }
  if (canonical.length) {
    const adapter = fs.readFileSync(path.join(adaptersDir, "encounters.live.ts"), "utf8");
    const dispatcher = fs.readFileSync(path.join(root, "src", "server", "clinical-core", "aws-production-desktop.ts"), "utf8");
    if (!adapter.includes('process.env.CLINICAL_EMR_SAVE_RECEIPT_ENABLED === "true"')
      || !dispatcher.includes('process.env.CLINICAL_EMR_SAVE_RECEIPT_ENABLED !== "true"')) {
      fail("blocked candidate RPCs must remain behind the explicit adapter and dispatcher gates");
    }
  }
  return canonical;
}

let manifest;
let productionManifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  productionManifest = JSON.parse(fs.readFileSync(productionManifestPath, "utf8"));
} catch (error) {
  fail(`cannot read operation manifest: ${error instanceof Error ? error.message : "invalid JSON"}`);
  process.exit();
}

const productionNativeRpc = new Set();
if (productionManifest.schemaVersion !== "desktop-production-operations/1"
  || productionManifest.activationState !== "phi_disabled"
  || !Array.isArray(productionManifest.operations)) {
  fail("production operation manifest is missing or invalid");
} else {
  for (const operation of productionManifest.operations) {
    if (operation?.kind === "rpc"
      && operation?.implementation === "native_production_function"
      && typeof operation?.name === "string"
      && typeof operation?.source === "string"
      && fs.existsSync(path.join(root, operation.source))) {
      productionNativeRpc.add(operation.name);
    }
  }
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
const blockedRpcs = blockedCandidateNames(manifest.blockedCandidateRpcs, productionNativeRpc);
for (const name of blockedRpcs) {
  if (reviewed.rpc.includes(name)) fail(`blocked candidate ${name} must not be in the active reviewed RPC list`);
}
const actual = sourceOperations();
compare("rpc", [...new Set([...reviewed.rpc, ...blockedRpcs])].sort(), actual.rpc);
compare("select", reviewed.select, actual.select);

const legacyFunctions = legacyFunctionDefinitions();
const undefinedRpc = reviewed.rpc.filter(
  (name) => !legacyFunctions.has(name) && !productionNativeRpc.has(name),
);
if (undefinedRpc.length) {
  fail(`RPCs have no authored legacy or native-production PostgreSQL function: ${undefinedRpc.join(", ")}`);
}

if (!process.exitCode) {
  console.log(
    `[aws-desktop-compatibility] PASS — ${reviewed.rpc.length} active RPCs, ${blockedRpcs.length} blocked candidate RPCs, and ${reviewed.select.length} `
      + "read models are explicitly reviewed; active RPCs have authored legacy or native-production PostgreSQL definitions.",
  );
}
