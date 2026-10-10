if (typeof window !== 'undefined') throw Error('inventory qualification artifacts are server-only');
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { INVENTORY_FLEET_SPECS } from '../../../scripts/inventory-qualification-fleet-specs.mjs';
import { inventoryFleetTemplate } from '../../../scripts/inventory-qualification-fleet-template.mjs';
import { inventoryQualificationZip } from '../../../scripts/inventory-qualification-zip.mjs';
import { inventoryCareTemplate, INVENTORY_PARENT, INVENTORY_PROFILE, INVENTORY_RELEASE } from '../../../scripts/inventory-care-qualification-template.mjs';

export const INVENTORY_CANDIDATES = [...INVENTORY_FLEET_SPECS.map(s => s.name), 'care-messaging', 'care-connections'] as const;
export class InventoryQualificationError extends Error {
  constructor(readonly category: string) { super(category); this.name = 'InventoryQualificationError'; }
}
export const inventoryRefuse = (category: string): never => { throw new InventoryQualificationError(category); };
export const inventorySha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const inventoryRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function inventoryCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inventoryCanonical).join(',')}]`;
  if (inventoryRecord(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${inventoryCanonical(v[k])}`).join(',')}}`;
  const result = JSON.stringify(v); if (result === undefined) return inventoryRefuse('value_refused'); return result;
}
const same = (a: unknown, b: unknown) => { if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse('artifact_mapping_refused'); };
const hash = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/;
const rootName = /^[a-z][a-z0-9-]*\.(?:js|json|zip)$/;
const mappingName = /^[A-Za-z][A-Za-z0-9]*$/;
export type InventorySource = { sourceCommit: string; sourceClean: boolean; sourceInputSha256: string };
export type InventoryParameter = { Type: string; Default?: string | number; AllowedValues?: Array<string | number>; AllowedPattern?: string;
  MinLength?: number; MaxLength?: number; MinValue?: number; MaxValue?: number; NoEcho?: boolean };
export type InventoryTemplate = { Parameters: Record<string, InventoryParameter>; Conditions: Record<string, unknown>;
  Resources: Record<string, { Type: string; Condition?: string; Properties: Record<string, unknown> }>; Outputs: Record<string, unknown>; Rules?: unknown };
export type InventoryPackage = { file: string; sha256: string; bytes: number; bucketParameter: string; keyParameter: string; versionParameter: string;
  files: Array<{ name: string; sha256: string; bytes: number }> };
export type InventoryBinding = { logicalId: string; file: string; handler: string; kind: 'api' | 'worker'; activationKey: string;
  bucketParameter: string; keyParameter: string; versionParameter: string };
export type InventoryCandidateArtifact = { candidate: string; manifestSha256: string; templateSha256: string; template: InventoryTemplate;
  bindings: InventoryBinding[]; packages: InventoryPackage[] };
export type InventoryArtifactSet = { source: InventorySource; manifestSha256: string; candidates: InventoryCandidateArtifact[] };

/** Regular, bounded files only. An observed source-byte set is not an atomic filesystem snapshot. */
export function inventoryBoundedFile(root: string, names: string[], bound: number): Buffer {
  if (!names.length || names.some(n => !/^[a-z][a-z0-9.-]*$/.test(n) || n === '.' || n === '..')) return inventoryRefuse('artifact_path_refused');
  const base = realpathSync(root), file = join(base, ...names), parent = realpathSync(dirname(file));
  const displacement = relative(base, parent);
  if (isAbsolute(displacement) || displacement === '..' || displacement.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return inventoryRefuse('artifact_path_refused');
  for (let n = 1; n < names.length; n++) {
    const folder = lstatSync(join(base, ...names.slice(0, n)));
    if (!folder.isDirectory() || folder.isSymbolicLink()) return inventoryRefuse('artifact_path_refused');
  }
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > bound) return inventoryRefuse('artifact_file_refused');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return inventoryRefuse('artifact_file_changed');
    // Read at most the observed length plus one byte. A growing file must not
    // turn readFileSync into an unbounded allocation before the final check.
    const buffer = Buffer.alloc(before.size + 1); let received = 0;
    while (received < buffer.length) {
      const read = readSync(fd, buffer, received, buffer.length - received, received);
      if (!read) break; received += read;
    }
    const bytes = buffer.subarray(0, received), after = fstatSync(fd), named = lstatSync(file);
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size
      || named.mtimeMs !== before.mtimeMs || named.isSymbolicLink()) return inventoryRefuse('artifact_file_changed');
    return bytes;
  } finally { closeSync(fd); }
}
function parsed(bytes: Buffer): Record<string, unknown> {
  try { const v: unknown = JSON.parse(bytes.toString('utf8')); if (inventoryRecord(v)) return v; } catch { /* fixed refusal */ }
  return inventoryRefuse('artifact_json_refused');
}
const ref = (v: unknown): string => {
  if (!inventoryRecord(v) || Object.keys(v).length !== 1 || typeof v.Ref !== 'string' || !mappingName.test(v.Ref)) return inventoryRefuse('artifact_mapping_refused');
  return v.Ref;
};
function template(bytes: Buffer): InventoryTemplate {
  const v = parsed(bytes);
  if (!inventoryRecord(v.Parameters) || !inventoryRecord(v.Resources) || !inventoryRecord(v.Conditions) || !inventoryRecord(v.Outputs)) return inventoryRefuse('artifact_template_refused');
  for (const p of Object.values(v.Parameters)) if (!inventoryRecord(p) || !['String', 'Number', 'CommaDelimitedList'].includes(String(p.Type)) || p.NoEcho === true) return inventoryRefuse('artifact_parameter_refused');
  for (const r of Object.values(v.Resources)) if (!inventoryRecord(r) || typeof r.Type !== 'string' || !inventoryRecord(r.Properties)) return inventoryRefuse('artifact_template_refused');
  return v as InventoryTemplate;
}
function pinIdentity(v: Record<string, unknown>, source: InventorySource) {
  for (const [k, expected] of Object.entries(source)) if (v[k] !== expected) inventoryRefuse('artifact_source_refused');
  if (v.migrationCount !== 107 || v.migrationReleaseSha256 !== INVENTORY_RELEASE || v.qualificationProfile !== INVENTORY_PROFILE) inventoryRefuse('artifact_release_refused');
}
function bindings(t: InventoryTemplate, functions: Array<{ id: string; file: string; kind: 'api' | 'worker'; exportName: string; activation: string }>): InventoryBinding[] {
  same(Object.entries(t.Resources).filter(([, r]) => r.Type === 'AWS::Lambda::Function').map(([id]) => id).sort(), functions.map(f => f.id).sort());
  return functions.map(f => {
    const p = t.Resources[f.id].Properties;
    if (!inventoryRecord(p.Code) || !inventoryRecord(p.Environment) || !inventoryRecord(p.Environment.Variables)
      || !Object.hasOwn(p.Environment.Variables, f.activation) || p.Handler !== `${f.file.slice(0, -3)}.${f.exportName}` || p.Runtime !== 'nodejs22.x') return inventoryRefuse('artifact_mapping_refused');
    return { logicalId: f.id, file: f.file, kind: f.kind, activationKey: f.activation, handler: p.Handler,
      bucketParameter: ref(p.Code.S3Bucket), keyParameter: ref(p.Code.S3Key), versionParameter: ref(p.Code.S3ObjectVersion) };
  });
}

/** Bind actual bytes, not manifest assertions alone. The CLI must first rebuild
 * clean source and supply its independently observed identity. This reader itself
 * does not prove source provenance, a human review, deployment or live configuration. */
export function readInventoryQualificationArtifacts(directory: string, source: InventorySource): InventoryArtifactSet {
  if (!commit.test(source.sourceCommit) || !hash.test(source.sourceInputSha256) || typeof source.sourceClean !== 'boolean') return inventoryRefuse('artifact_source_refused');
  const root = resolve(directory), rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return inventoryRefuse('artifact_path_refused');
  const summaryBytes = inventoryBoundedFile(root, ['manifest.json'], 1024 * 1024), summary = parsed(summaryBytes);
  pinIdentity(summary, source);
  if (summary.contract !== 'inventory-qualification-fleet-build/1' || summary.artifactSetComplete !== true
    || summary.targetBindingComplete !== false || summary.deploymentPerformed !== false || summary.hostedVerified !== false || summary.phiAllowed !== false || summary.activation !== 'blocked'
    || !Array.isArray(summary.candidates) || summary.candidates.length !== 12) return inventoryRefuse('artifact_fleet_refused');
  same(summary.candidates.map(c => inventoryRecord(c) ? c.candidate : null).sort(), [...INVENTORY_CANDIDATES].sort());
  const candidates = summary.candidates.map(item => {
    if (!inventoryRecord(item) || typeof item.candidate !== 'string' || !hash.test(String(item.manifestSha256)) || !hash.test(String(item.templateSha256))) return inventoryRefuse('artifact_fleet_refused');
    const name = item.candidate, spec = INVENTORY_FLEET_SPECS.find(s => s.name === name);
    const manifestBytes = inventoryBoundedFile(root, [name, 'artifact-manifest.json'], 1024 * 1024), m = parsed(manifestBytes);
    const templateBytes = inventoryBoundedFile(root, [name, 'template.json'], 2 * 1024 * 1024), t = template(templateBytes);
    if (inventorySha(manifestBytes) !== item.manifestSha256 || inventorySha(templateBytes) !== item.templateSha256
      || m.templateSha256 !== item.templateSha256 || m.candidate !== name || m.deploymentPerformed !== false || m.hostedVerified !== false) return inventoryRefuse('artifact_hash_refused');
    pinIdentity(m, source);
    let mapped: InventoryBinding[], packages: InventoryPackage[];
    if (spec) {
      if (m.contract !== 'inventory-qualification-candidate/1' || m.productionActivationPossible !== false) return inventoryRefuse('artifact_contract_refused');
      same(m.defaults, { phiAllowed: false, activation: 'blocked', qualification: 'disabled' });
      const parentBytes = inventoryBoundedFile(root, [name, 'historical-builder', 'template.json'], 2 * 1024 * 1024);
      if (m.parentTemplateSha256 !== inventorySha(parentBytes)) return inventoryRefuse('artifact_parent_refused');
      const expected = inventoryFleetTemplate(parsed(parentBytes), source.sourceCommit, spec);
      same(t, expected.template); mapped = bindings(t, spec.functions); same(mapped, m.lambdaBindings); same(mapped, expected.bindings);
      if (!Array.isArray(m.packages)) return inventoryRefuse('artifact_package_refused');
      packages = m.packages.map(p => {
        if (!inventoryRecord(p) || typeof p.file !== 'string' || !rootName.test(p.file) || !p.file.endsWith('.zip') || !hash.test(String(p.sha256))
          || !Number.isSafeInteger(p.bytes) || !Array.isArray(p.files) || !p.files.length || p.files.length > 16
          || ['bucketParameter', 'keyParameter', 'versionParameter'].some(k => typeof p[k] !== 'string' || !mappingName.test(String(p[k])))) return inventoryRefuse('artifact_package_refused');
        const files = p.files.map(f => {
          if (!inventoryRecord(f) || typeof f.name !== 'string' || !/^[a-z][a-z0-9-]*\.js$/.test(f.name) || !hash.test(String(f.sha256)) || !Number.isSafeInteger(f.bytes)) return inventoryRefuse('artifact_package_refused');
          const bytes = inventoryBoundedFile(root, [name, f.name], 45 * 1024 * 1024);
          if (bytes.length !== f.bytes || inventorySha(bytes) !== f.sha256) return inventoryRefuse('artifact_hash_refused');
          return { name: f.name, bytes };
        });
        const zip = inventoryBoundedFile(root, [name, p.file], 46 * 1024 * 1024);
        if (zip.length !== p.bytes || inventorySha(zip) !== p.sha256 || !inventoryQualificationZip(files).equals(zip)) return inventoryRefuse('artifact_zip_refused');
        return p as InventoryPackage;
      });
      const wanted = new Map<string, Set<string>>();
      for (const b of mapped) {
        const key = `${b.bucketParameter}:${b.keyParameter}:${b.versionParameter}`, set = wanted.get(key) ?? new Set<string>();
        set.add(b.file); if (spec.runtime) set.add(spec.runtime); wanted.set(key, set);
      }
      same(packages.map(p => `${p.bucketParameter}:${p.keyParameter}:${p.versionParameter}`).sort(), [...wanted.keys()].sort());
      for (const p of packages) same(p.files.map(f => f.name).sort(), [...wanted.get(`${p.bucketParameter}:${p.keyParameter}:${p.versionParameter}`)!].sort());
      if (spec.runtime) same(inventorySha(inventoryBoundedFile(root, [name, spec.runtime], 45 * 1024 * 1024)),
        inventorySha(inventoryBoundedFile(root, [name, 'historical-builder', spec.runtime], 45 * 1024 * 1024)));
    } else {
      if (m.contract !== 'inventory-care-qualification-deployment/1' || m.activationApproved !== false) return inventoryRefuse('artifact_contract_refused');
      same(m.defaults, { phiAllowed: false, activation: 'blocked', qualification: 'disabled', ...(name === 'care-connections' ? { claimRecoveryEnabled: false } : {}) });
      const parentBytes = inventoryBoundedFile(root, ['care-build', name, 'historical-106', 'template.json'], 2 * 1024 * 1024);
      if (m.parentTemplateSha256 !== inventorySha(parentBytes)) return inventoryRefuse('artifact_parent_refused');
      const parentManifestBytes = inventoryBoundedFile(root, ['care-build', name, 'historical-106', 'artifact-manifest.json'], 1024 * 1024), parentManifest = parsed(parentManifestBytes);
      if (m.parentManifestSha256 !== inventorySha(parentManifestBytes) || parentManifest.migrationCount !== 106 || parentManifest.migrationReleaseSha256 !== INVENTORY_PARENT
        || parentManifest.sourceCommit !== source.sourceCommit || parentManifest.sourceClean !== source.sourceClean
        || parentManifest.templateSha256 !== inventorySha(parentBytes) || !Array.isArray(parentManifest.functions) || parentManifest.functions.length !== 7) return inventoryRefuse('artifact_parent_refused');
      same(m.functions, parentManifest.functions);
      if (name === 'care-connections') {
        if (!Array.isArray(parentManifest.claimFunctions) || parentManifest.claimFunctions.length !== 2) return inventoryRefuse('artifact_parent_refused');
        same(m.claimFunctions, parentManifest.claimFunctions);
      }
      same(t, inventoryCareTemplate(parsed(parentBytes), source.sourceCommit));
      mapped = bindings(t, [{ id: 'Function', file: 'index.js', kind: 'api', exportName: 'handler',
        activation: name === 'care-messaging' ? 'CARE_MESSAGING_ACTIVATION' : 'CARE_CONNECTIONS_ACTIVATION' }]);
      const code = inventoryBoundedFile(root, [name, 'index.js'], 45 * 1024 * 1024), zip = inventoryBoundedFile(root, [name, 'deployment.zip'], 46 * 1024 * 1024);
      if (inventorySha(code) !== m.codeSha256 || inventorySha(zip) !== m.deploymentZipSha256 || zip.length !== m.deploymentZipBytes
        || !inventoryQualificationZip([{ name: 'index.js', bytes: code }]).equals(zip)) return inventoryRefuse('artifact_zip_refused');
      packages = [{ file: 'deployment.zip', sha256: inventorySha(zip), bytes: zip.length,
        bucketParameter: mapped[0].bucketParameter, keyParameter: mapped[0].keyParameter, versionParameter: mapped[0].versionParameter,
        files: [{ name: 'index.js', sha256: inventorySha(code), bytes: code.length }] }];
    }
    same(item.packages, packages.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })));
    return { candidate: name, manifestSha256: String(item.manifestSha256), templateSha256: String(item.templateSha256), template: t, bindings: mapped, packages };
  });
  if (candidates.reduce((n, c) => n + c.bindings.length, 0) !== 15 || candidates.reduce((n, c) => n + c.packages.length, 0) !== 13) return inventoryRefuse('artifact_fleet_refused');
  return structuredClone({ source, manifestSha256: inventorySha(summaryBytes), candidates });
}
