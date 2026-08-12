import { readFileSync } from "node:fs";
import { runSyntheticApiAcceptance } from "./synthetic-acceptance";
import { validateSyntheticAcceptanceManifest } from "./synthetic-fixtures";

async function main() {
  const manifestPath = required("CLINICAL_SYNTHETIC_MANIFEST");
  const manifest = validateSyntheticAcceptanceManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const result = await runSyntheticApiAcceptance({
    apiOrigin: required("CLINICAL_API_ORIGIN"),
    workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"),
    consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"),
    manifest,
  });
  console.log(JSON.stringify({ ok: true, ...result, environment: "synthetic-staging" }));
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("acceptance_configuration_missing");
  return value;
}

main().catch((error) => {
  const category = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed";
  console.error(JSON.stringify({ ok: false, error: category }));
  process.exitCode = 1;
});
