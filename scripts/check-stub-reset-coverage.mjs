#!/usr/bin/env node
/**
 * Gate: every mutable top-level binding in the live stub must be covered by the
 * reset mechanism.
 *
 * The E2E battery is only order-independent if `resetAllFixtures()` genuinely
 * restores everything. That guarantee decays the moment somebody adds a new
 * `const somethingNew = new Map()` and forgets the reset — and the failure it
 * produces is a *later* suite reporting a product bug that does not exist.
 * That is expensive to diagnose and trivial to prevent, so it is checked here
 * rather than remembered.
 *
 * A binding is covered if it is either:
 *   - listed in `SNAPSHOT_COLLECTIONS` (restored in place from a load-time
 *     deep snapshot), or
 *   - reassigned inside `resetAllFixtures()`, directly or by one of the domain
 *     reset functions that body calls.
 *
 * Deliberately NOT covered, and why, is declared in ALLOWED_IMMUTABLE below.
 */

import { readFileSync } from "node:fs";

const FILE = "scripts/live-stub-server.mjs";
const src = readFileSync(FILE, "utf8");
const lines = src.split("\n");

/**
 * Bindings that are genuinely immutable fixtures or constants. Each needs a
 * reason: "it looked constant" is how a mutable one gets waved through.
 */
const ALLOWED_IMMUTABLE = new Map([
  ["now", "load-time timestamp; every fixture date is derived from it"],
  ["__fixtureSnapshots", "the snapshot store itself — resetting it would erase what reset restores from"],
  // Read-only reference data. Each was verified by grepping for mutating calls
  // (push/splice/set/delete/add/sort and indexed assignment) and found to have
  // none. `labReports` looked like this group and is NOT in it: an uploaded lab
  // report pushes a row, so it is snapshotted.
  ["PATIENTS", "read-only patient roster"],
  ["scribeDocs", "read-only consent document catalogue"],
  ["LENS_PARADIGM_ROWS", "read-only paradigm reference rows"],
  ["LENS_DOMAIN_ROWS", "read-only domain reference rows"],
  ["LENS_SOURCES", "read-only knowledge-source reference rows"],
  ["LENS_INJECTION_PATTERNS", "read-only prompt-injection detection patterns"],
  ["CATALOG", "read-only product catalogue reference rows"],
  ["CATALOG_INTERACTIONS", "read-only interaction reference rows"],
  ["PROTOCOL_MEDICATIONS", "read-only medication reference rows"],
  ["INBOX_URGENT_TERMS", "read-only urgency term list"],
  ["INBOX_CATEGORIES", "read-only category list"],
]);

/** Mutable shapes worth policing. A scalar counter is as dangerous as a Map. */
const MUTABLE_INIT = /^(new Map\(\)|new Set\(\)|\[\]|0|null)$/;

const declPattern =
  /^(let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(new Map\(\)|new Set\(\)|\[\]|0|null)\s*;/;

/** Multi-line seeded collections: `const queue = new Map(` / `= [` on its own. */
const seededPattern = /^(let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(new Map\(|new Set\(|\[)\s*$/;

const declared = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  let m = declPattern.exec(line);
  if (m && MUTABLE_INIT.test(m[3])) {
    declared.push({ name: m[2], line: i + 1, kind: m[1] });
    continue;
  }
  m = seededPattern.exec(line);
  if (m) declared.push({ name: m[2], line: i + 1, kind: m[1] });
}

// ---- what the reset actually covers -------------------------------------

const snapBlock = src.slice(
  src.indexOf("const SNAPSHOT_COLLECTIONS = {"),
  src.indexOf("};", src.indexOf("const SNAPSHOT_COLLECTIONS = {")),
);
if (!snapBlock) {
  console.error("[stub-reset] FAIL — SNAPSHOT_COLLECTIONS not found");
  process.exit(1);
}
const snapshotted = new Set(
  snapBlock
    .replace("const SNAPSHOT_COLLECTIONS = {", "")
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean),
);

/** Body of a named function declaration, brace-matched. */
function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return "";
  let depth = 0;
  let i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return "";
}

const resetBody = functionBody("resetAllFixtures");
if (!resetBody) {
  console.error("[stub-reset] FAIL — resetAllFixtures() not found");
  process.exit(1);
}

// Follow the domain resets it delegates to, one level.
let effectiveBody = resetBody;
for (const called of resetBody.matchAll(/\b(reset[A-Za-z]*Fixtures)\(\)/g)) {
  if (called[1] !== "resetAllFixtures") effectiveBody += functionBody(called[1]);
}

const reassigned = new Set(
  [...effectiveBody.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]),
);

// ---- report --------------------------------------------------------------

const uncovered = declared.filter(
  (d) =>
    !snapshotted.has(d.name) &&
    !reassigned.has(d.name) &&
    !ALLOWED_IMMUTABLE.has(d.name),
);

// A name in both mechanisms is a real hazard: the snapshot restores it and the
// domain reset then reassigns the binding, so the restored contents are thrown
// away and whichever runs last silently wins.
const doubled = declared.filter(
  (d) => snapshotted.has(d.name) && reassigned.has(d.name),
);

if (uncovered.length || doubled.length) {
  console.error(`[stub-reset] FAIL — ${FILE}`);
  for (const d of uncovered) {
    console.error(
      `  uncovered: ${d.name} (${d.kind}, line ${d.line}) — add it to ` +
        `SNAPSHOT_COLLECTIONS, reset it in resetAllFixtures, or declare it in ` +
        `ALLOWED_IMMUTABLE with a reason.`,
    );
  }
  for (const d of doubled) {
    console.error(
      `  covered twice: ${d.name} (line ${d.line}) — it is both snapshotted ` +
        `and reassigned, so the reassignment discards the restored contents. ` +
        `Pick one mechanism.`,
    );
  }
  process.exit(1);
}

console.log(
  `[stub-reset] PASS — ${declared.length} mutable bindings, ` +
    `${snapshotted.size} snapshotted, ${reassigned.size} reassigned, ` +
    `${ALLOWED_IMMUTABLE.size} declared immutable. Every one is covered.`,
);
