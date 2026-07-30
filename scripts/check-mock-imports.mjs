#!/usr/bin/env node
/**
 * CLINICAL IMPORT-GRAPH GUARD.
 *
 * Walks the real import graph from every production entry point (all
 * `src/app/**` pages, layouts, API routes, and shared shell files) and fails
 * if any path reaches:
 *
 *   1. a mock module        (src/adapters/*.mock.ts)
 *   2. a demo session store (session-store.ts, session-kv.ts,
 *                            appointments.session.ts, demo-reset.ts)
 *
 * Test files are NOT entry points; fixtures remain for vitest/Playwright and
 * are exactly where synthetic data is allowed to live. Type-only imports are
 * ignored — `import type` is erased at compile time and ships no fixture data.
 *
 * This is the structural proof behind "the clinical runtime cannot fall back
 * to mock data": not a convention, a failing build.
 *
 * Usage: node scripts/check-mock-imports.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

const SRC = "src";
const APP = "src/app";

const FORBIDDEN = [
  /\/adapters\/[^/]+\.mock$/,
  /\/adapters\/session-store$/,
  /\/adapters\/session-kv$/,
  /\/adapters\/appointments\.session$/,
  /\/adapters\/demo-reset$/,
];

/** Where a specifier like "@/x" or "./x" resolves to, or null for externals. */
function resolveSpec(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null; // node_modules
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return resolve(c);
  }
  return null;
}

/** Value imports only — `import type` / `export type` are erased. */
const IMPORT_RE =
  /(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) out.push(full);
  }
  return out;
}

// Entry points: everything under src/app (pages, layouts, API routes).
const entries = walkDir(APP).map((f) => resolve(f));

const violations = [];
const visited = new Map(); // absFile -> first import chain (array)

function visit(file, chain) {
  if (visited.has(file)) return;
  visited.set(file, chain);

  for (const spec of importsOf(file)) {
    const target = resolveSpec(spec, file);
    if (!target) continue;

    const normalized = target.split(sep).join("/").replace(/\.(ts|tsx|mts)$/, "");
    const hit = FORBIDDEN.find((re) => re.test(normalized));
    if (hit) {
      violations.push({ chain: [...chain, file, target] });
      continue; // report, don't recurse into fixtures
    }
    visit(target, [...chain, file]);
  }
}

for (const entry of entries) visit(entry, []);

if (violations.length > 0) {
  console.error(
    `[mock-imports] FAIL — ${violations.length} production import path(s) reach mock/session modules:\n`,
  );
  const seen = new Set();
  for (const { chain } of violations) {
    const tail = chain[chain.length - 1];
    const key = `${chain[chain.length - 2]}=>${tail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(
      "  " +
        chain
          .map((f) => f.split(`${sep}src${sep}`)[1] ?? f)
          .join("\n    → "),
    );
    console.error("");
  }
  console.error(
    `A production route can reach a mock module or demo session store. The\n` +
      `clinical runtime must reach the Desktop-owned boundary or refuse honestly\n` +
      `— never fall back to fixtures. Wire the domain live or route it to an\n` +
      `unavailable state (docs/clinical-runtime-migration.md).`,
  );
  process.exit(1);
}

console.log(
  `[mock-imports] PASS — ${entries.length} entry files, ${visited.size} reachable modules, ` +
    `no path to *.mock.ts or demo session stores.`,
);
