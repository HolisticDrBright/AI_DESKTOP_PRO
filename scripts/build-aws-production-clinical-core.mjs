import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(root, "infra", "aws-clinical-core", "migrations");
const overlayDirectory = path.join(root, "infra", "aws-clinical-core", "production-migrations");
const outputDirectory = path.join(root, "dist", "aws-clinical-core", "production-migrations");
const jsonOnly = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !jsonOnly) throw new Error('Usage: build-aws-production-clinical-core.mjs [--json]');

const sourceManifest = JSON.parse(readFileSync(path.join(sourceDirectory, "manifest.json"), "utf8"));
if (sourceManifest.contract_version !== "clinical-core-migrations/1") {
  throw new Error("Unsupported clinical-core migration manifest.");
}

const renameFile = (file) => file
  .replaceAll("synthetic", "production")
  .replaceAll("Synthetic", "Production");

function transformToProduction(sql) {
  let result = sql;
  const replacements = [
    ["patient_syn_", "patient_"],
    ["synthetic-staging", "production-clinical"],
    ["synthetic_only", "clinical_phi"],
    ["synthetic_subject_key", "subject_key"],
    ["synthetic_record_key", "patient_key"],
    ["synthetic_attested", "production_bound"],
    ["assert_synthetic_context", "assert_production_context"],
    ["synthetic_context_refused", "production_context_refused"],
    ["synthetic_label", "organization_label"],
    ["^syn_[A-Za-z0-9_-]{8,96}$", "^subject_[A-Za-z0-9_-]{8,96}$"],
    ["'syn_'", "'subject_'"],
    ["contains_phi boolean not null default false check (contains_phi = false)",
      "contains_phi boolean not null default true check (contains_phi = true)"],
    ["contains_phi = false", "contains_phi = true"],
  ];
  for (const [from, to] of replacements) result = result.replaceAll(from, to);

  // Provider-specific references only occur in explanatory comments. Remove
  // them as well so the generated production artifact can be scanned as a
  // self-contained Aurora contract.
  result = result
    .replaceAll("Supabase", "provider-specific")
    .replaceAll("supabase", "provider-specific")
    .replaceAll("auth.uid()", "provider identity helper")
    .replaceAll("synthetic", "production")
    .replaceAll("Synthetic", "Production");
  return result;
}

function assertProductionArtifact(file, sql) {
  if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) throw new Error('Invalid production migration filename.');
  const forbidden = [
    /synthetic/i,
    /supabase/i,
    /\bauth\./i,
    /\bfly\b/i,
    /app\s*runner/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(sql)) throw new Error(`${file} contains forbidden production token ${pattern}.`);
  }
}

// Validate and hash one immutable in-memory artifact before touching the output.
// Database tests use --json so concurrent tests cannot erase each other's files.
const files = Object.create(null);
const migrations = [];
for (const entry of sourceManifest.migrations.filter((migration) => migration.production_transform !== false)) {
  const source = readFileSync(path.join(sourceDirectory, entry.file), "utf8");
  const outputFile = renameFile(entry.file);
  const output = transformToProduction(source);
  assertProductionArtifact(outputFile, output);
  files[outputFile] = output;
  migrations.push({ version: entry.version, file: outputFile });
}

const overlayManifest = JSON.parse(readFileSync(path.join(overlayDirectory, "manifest.json"), "utf8"));
if (overlayManifest.contract_version !== "clinical-core-production-overlays/1") {
  throw new Error("Unsupported production overlay manifest.");
}
for (const entry of overlayManifest.migrations) {
  const source = readFileSync(path.join(overlayDirectory, entry.file), "utf8");
  assertProductionArtifact(entry.file, source);
  files[entry.file] = source;
  migrations.push(entry);
}
const registeredOverlays=new Set(overlayManifest.migrations.map(entry=>entry.file));
const omitted=readdirSync(overlayDirectory).filter(file=>file.endsWith('.sql')&&!registeredOverlays.has(file));
if(omitted.length)throw new Error(`Unregistered production migration(s): ${omitted.join(', ')}`);

for (let index = 1; index < migrations.length; index += 1) {
  if (migrations[index].version <= migrations[index - 1].version) {
    throw new Error("Production migrations are not strictly ordered.");
  }
}

const manifest = { contract_version: "clinical-core-migrations/1", migrations };
const combined = migrations
  .map(({ file }) => files[file])
  .join("\n");
for (const required of ["production-clinical", "clinical_phi", "production_bound", "contains_phi = true"]) {
  if (!combined.includes(required)) throw new Error(`Production output is missing required marker ${required}.`);
}

const releaseHash = createHash("sha256")
  .update(migrations.map(({ version, file }) => {
    const sql = files[file];
    return `${version}:${file}:${createHash("sha256").update(sql).digest("hex")}`;
  }).join("\n"))
  .digest("hex");

if (jsonOnly) {
  process.stdout.write(JSON.stringify({ manifest, files, releaseHash }));
} else {
  // The exact generated directory is fixed beneath this repository's dist.
  const relative = path.relative(root, outputDirectory);
  if (relative !== path.join('dist', 'aws-clinical-core', 'production-migrations')) throw new Error('unsafe_build_output');
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const { file } of migrations) writeFileSync(path.join(outputDirectory, file), files[file]);
  writeFileSync(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built ${migrations.length} production clinical-core migrations (${releaseHash}).`);
}
