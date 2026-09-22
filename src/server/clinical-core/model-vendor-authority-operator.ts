if (typeof window !== "undefined") {
  throw new Error("model-vendor-authority-operator is server-only.");
}

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { errorCode } from "./log-safe-error";
import { ModelVendorAuthorityRefusal } from "./model-vendor-authority";
import { runModelVendorAuthorityOperator } from "./model-vendor-authority-secret";

/**
 * Operator entry point for the switch that stops every model call. `inspect` is read-only; `suspend` and `terminate`
 * stop every path on the next call; `activate` permits again and asks for the confirmations the stopping direction does
 * not. The decision itself lives in model-vendor-authority-secret; this file is the command line around it.
 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

async function run() {
  const report = await runModelVendorAuthorityOperator({
    command: process.argv[2] ?? "",
    environment: process.env,
    secrets: new SecretsManagerClient({ region: required("AWS_REGION") }),
  });
  console.log(JSON.stringify(report));
}

run().catch((error) => {
  console.error(error instanceof ModelVendorAuthorityRefusal ? error.category : errorCode(error, "model_vendor_authority_operator_failed"));
  process.exitCode = 1;
});
