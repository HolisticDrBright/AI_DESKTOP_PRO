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

const deploy = readFileSync("scripts/deploy-aws-production-foundation.ps1", "utf8");
for (const [command, refusal] of [
  ["bun run build:aws-production-foundation", "Production foundation build failed"],
  ["bun run check:aws-production-foundation", "Production foundation source check failed"],
  ["aws cloudformation validate-template", "Production foundation template validation failed"],
  ["aws s3control put-public-access-block", "Account public-access-block update failed"],
]) {
  assert(deploy.includes(command) && deploy.includes(refusal), `${command} must have an explicit refusal`);
}
assert(deploy.indexOf("check-aws-production-identity-template-drift.mjs")
  < deploy.indexOf("aws s3control put-public-access-block"), "identity review must precede every AWS write");
