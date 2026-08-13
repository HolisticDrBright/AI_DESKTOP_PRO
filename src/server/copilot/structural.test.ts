import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const COPILOT_DIR = join(process.cwd(), "src", "server", "copilot");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const COMMERCIAL_TOKENS: RegExp[] = [
  /\bfrom\s+["'][^"']*commercial[^"']*["']/i,
  /\bfrom\s+["'][^"']*affiliate[^"']*["']/i,
  /product_label_commercial_links/,
  /catalog_commercial/,
  /\baffiliate_url\b/,
  /\bcommission\b/i,
  /\bsupplier_ranking\b/,
  /\bdiscount_code\b/,
];

describe("copilot module structural isolation", () => {
  test("no clinical copilot source imports or references a commercial namespace", () => {
    const files = walk(COPILOT_DIR);
    const violations: Array<{ file: string; token: string }> = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const rx of COMMERCIAL_TOKENS) {
        if (rx.test(src)) violations.push({ file: f, token: rx.source });
      }
    }
    expect(violations).toEqual([]);
  });
});
