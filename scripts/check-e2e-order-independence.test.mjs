import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertListedSpecOrder,
  createOrderedAliases,
  orderedAliasPlan,
  removeOrderedAliases,
} from "./e2e-ordered-specs.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, "scripts", "check-e2e-order-independence.mjs");
const playwright = join(root, "node_modules", "@playwright", "test", "cli.js");

test("the order proof reverses Playwright's observed collection order, not just CLI arguments", () => {
  const specs = readdirSync(join(root, "e2e")).filter((name) => name.endsWith(".spec.ts")).sort();
  const forward = orderedAliasPlan(specs, "forward");
  const reverse = orderedAliasPlan([...specs].reverse(), "reverse");
  const created = createOrderedAliases(join(root, "e2e"), [...forward, ...reverse]);
  try {
    for (const [plan, expected] of [[forward, specs], [reverse, [...specs].reverse()]]) {
      const result = spawnSync(
        process.execPath,
        [playwright, "test", ...plan.map((item) => `e2e/${item.alias}`), "--list"],
        { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, E2E_ORDER_ALIASES: "1" } },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(assertListedSpecOrder(result.stdout, expected), expected);
    }
    const ignored = spawnSync(
      process.execPath,
      [playwright, "test", `e2e/${forward[0].alias}`, "--list"],
      { cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, E2E_ORDER_ALIASES: "0" } },
    );
    assert.notEqual(ignored.status, 0, "ordinary browser runs must ignore generated aliases");
    assert.match(`${ignored.stdout}\n${ignored.stderr}`, /No tests found/);
  } finally {
    removeOrderedAliases(created);
  }
});

test("the order proof refuses an incomplete or incorrectly sorted Playwright list", () => {
  assert.throws(
    () => assertListedSpecOrder("Listing tests:\n  a.spec.ts:1:1 › test\n", ["b.spec.ts"]),
    /did not collect the intended spec order/,
  );
});

function refusal(overrides) {
  const env = {
    ...process.env,
    APP_EDITION: "clinical",
    E2E_LIVE: "1",
    E2E_DEV_SERVER: "1",
    CLINICAL_CONTRACT_FIXTURE: "1",
    NODE_ENV: "",
    E2E_STUB_BASE: "http://127.0.0.1:3999",
    NEXT_PUBLIC_USE_LIVE_API: "true",
    TRPC_BASE_URL: "http://127.0.0.1:3999/api/trpc",
    CLINICAL_SUPABASE_URL: "http://127.0.0.1:3999",
    CLINICAL_SUPABASE_ANON_KEY: "stub",
    CLINICAL_DEMO_EMAIL: "demo@local",
    CLINICAL_DEMO_PASSWORD: "demo",
    CLINICAL_ORG_ID: "org-fixture",
    ...overrides,
  };
  const result = spawnSync(process.execPath, [runner], {
    cwd: root, env, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

test("the order runner refuses production posture before starting a fixture", () => {
  assert.match(refusal({ NODE_ENV: "production" }), /development browser server/);
});

test("the order runner refuses disabled fixture or development flags", () => {
  assert.match(refusal({ CLINICAL_CONTRACT_FIXTURE: "0" }), /development browser server/);
  assert.match(refusal({ E2E_DEV_SERVER: "0" }), /development browser server/);
});

test("the order runner refuses a hosted or credential-bearing fixture origin", () => {
  assert.match(refusal({ E2E_STUB_BASE: "https://example.com" }), /loopback HTTP fixture origin/);
  assert.match(refusal({ E2E_STUB_BASE: "http://user:pass@127.0.0.1:3999" }), /loopback HTTP fixture origin/);
});

test("the order runner refuses external API or clinical backends", () => {
  assert.match(refusal({ TRPC_BASE_URL: "https://example.com/api/trpc" }), /TRPC_BASE_URL/);
  assert.match(refusal({ CLINICAL_SUPABASE_URL: "https://example.com" }), /CLINICAL_SUPABASE_URL/);
});

test("the order runner refuses non-fictional credentials", () => {
  assert.match(refusal({ CLINICAL_SUPABASE_ANON_KEY: "some-key" }), /CLINICAL_SUPABASE_ANON_KEY/);
  assert.match(refusal({ CLINICAL_DEMO_EMAIL: "real@example.com" }), /CLINICAL_DEMO_EMAIL/);
});

test("the order runner refuses an invalid development heap before starting servers", () => {
  assert.match(refusal({ E2E_DEV_HEAP_MB: "2047" }), /E2E_DEV_HEAP_MB/);
});

test("the valid local configuration reaches the owned-port check", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("occupied");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(process.execPath, [runner], {
      cwd: root,
      env: {
        ...process.env,
        APP_EDITION: "clinical",
        E2E_LIVE: "1",
        E2E_DEV_SERVER: "1",
        CLINICAL_CONTRACT_FIXTURE: "1",
        NODE_ENV: "",
        E2E_STUB_BASE: "http://127.0.0.1:3999",
        NEXT_PUBLIC_USE_LIVE_API: "true",
        TRPC_BASE_URL: "http://127.0.0.1:3999/api/trpc",
        CLINICAL_SUPABASE_URL: "http://127.0.0.1:3999",
        CLINICAL_SUPABASE_ANON_KEY: "stub",
        CLINICAL_DEMO_EMAIL: "demo@local",
        CLINICAL_DEMO_PASSWORD: "demo",
        CLINICAL_ORG_ID: "org-fixture",
        E2E_PORT: String(address.port),
        E2E_DEV_HEAP_MB: "2048",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 2, output);
    assert.match(output, /something is already listening/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
