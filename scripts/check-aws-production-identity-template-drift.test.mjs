import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildProductionFoundation } from "./build-aws-production-foundation.mjs";
import { identityResourceDifferences } from "./check-aws-production-identity-template-drift.mjs";

const source = JSON.parse(readFileSync("infra/aws-clinical-core/template.json", "utf8"));
const proposed = buildProductionFoundation(source);
assert.deepEqual(identityResourceDifferences(proposed, structuredClone(proposed)), []);

const stale = structuredClone(proposed);
delete stale.Resources.WorkforceUserPool.Properties.VerificationMessageTemplate;
assert.deepEqual(identityResourceDifferences(stale, proposed), ["WorkforceUserPool"]);

const broaderClient = structuredClone(proposed);
broaderClient.Resources.ConsumerUserPoolClient.Properties.ReadAttributes.push("custom:synthetic_attested");
assert.deepEqual(identityResourceDifferences(proposed, broaderClient), ["ConsumerUserPoolClient"]);

const missing = structuredClone(proposed);
delete missing.Resources.WorkforceUserPool;
assert.deepEqual(identityResourceDifferences(missing, proposed), ["WorkforceUserPool"]);
assert.deepEqual(identityResourceDifferences(missing, missing), ["WorkforceUserPool"]);

console.log("Production identity template drift guard passed.");
