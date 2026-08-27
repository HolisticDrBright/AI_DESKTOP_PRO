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
if (committed.counts?.rpc !== 218 || committed.counts?.select !== 5 || committed.counts?.total !== 223) errors.push("operation counts changed without review");
if (committed.operations?.some((operation) => operation.kind === "rpc"
  && operation.legacyDefinitions.length === 0
  && !operation.productionEvidence)) errors.push("an RPC has no extracted legacy or native-production definition");
if (committed.operations?.some((operation) => operation.callSites.length === 0)) errors.push("an operation has no live adapter call site");
if (committed.counts?.productionImplemented !== 149 || committed.counts?.productionEnabled !== 0) {
  errors.push("production operation evidence must show one hundred forty-nine implemented core operations and zero enabled operations");
}
const implemented = committed.operations?.filter((operation) => operation.productionStatus === "implemented_activation_blocked") ?? [];
if (implemented.some((operation) => operation.productionEvidence?.activationState !== "phi_disabled"
  || !/^[0-9a-f]{64}$/.test(operation.productionEvidence?.sourceSha256 ?? ""))) {
  errors.push("an implemented production operation lacks PHI-disabled, hash-bound source evidence");
}

if (errors.length) {
  for (const error of errors) console.error(`Desktop operation inventory check failed: ${error}`);
  process.exitCode = 1;
} else {
  const providerBound = committed.operations.filter((operation) => operation.legacyDefinitions.some(
    (definition) => Object.values(definition.providerDependencies).some(Boolean),
  )).length;
  console.log(`Desktop operation inventory passed: 223 live operations, 149 implemented but activation-blocked, 0 enabled; ${providerBound} require provider-specific rewrites.`);
}
