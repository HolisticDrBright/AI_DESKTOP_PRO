import fs from "node:fs";
import path from "node:path";
import { buildDesktopOperationInventory } from "./build-aws-desktop-operation-inventory.mjs";

const inventoryPath = path.resolve("infra/aws-clinical-core/desktop-operation-port-inventory.json");
const expected = buildDesktopOperationInventory();
let committed;
try {
  committed = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
} catch {
  console.error("Desktop operation inventory check failed: committed inventory is missing or invalid.");
  process.exit(1);
}

const errors = [];
if (JSON.stringify(committed) !== JSON.stringify(expected)) errors.push("inventory is stale; run the build script with --write");
if (committed.counts?.rpc !== 217 || committed.counts?.select !== 5 || committed.counts?.total !== 222) errors.push("operation counts changed without review");
if (committed.operations?.some((operation) => operation.kind === "rpc" && operation.legacyDefinitions.length === 0)) errors.push("an RPC has no extracted definition");
if (committed.operations?.some((operation) => operation.callSites.length === 0)) errors.push("an operation has no live adapter call site");
if (committed.counts?.productionPorted !== 0) errors.push("inventory must not assert production ports; deployment evidence owns that status");

if (errors.length) {
  for (const error of errors) console.error(`Desktop operation inventory check failed: ${error}`);
  process.exitCode = 1;
} else {
  const providerBound = committed.operations.filter((operation) => operation.legacyDefinitions.some(
    (definition) => Object.values(definition.providerDependencies).some(Boolean),
  )).length;
  console.log(`Desktop operation inventory passed: 222 live operations, exact signatures/dependencies captured; ${providerBound} require provider-specific rewrites.`);
}
