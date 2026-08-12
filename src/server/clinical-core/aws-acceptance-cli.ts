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
    isolationWorkforceIdToken: required("CLINICAL_ISOLATION_WORKFORCE_ID_TOKEN"),
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
  const operationIndex = typeof error === "object" && error && "operationIndex" in error
    ? (error as { operationIndex?: unknown }).operationIndex : undefined;
  const statusCode = typeof error === "object" && error && "statusCode" in error
    ? (error as { statusCode?: unknown }).statusCode : undefined;
  const refusalCategory = typeof error === "object" && error && "refusalCategory" in error
    ? (error as { refusalCategory?: unknown }).refusalCategory : undefined;
  console.error(JSON.stringify({ ok: false, error: category,
    ...(typeof operationIndex === "number" ? { operationIndex } : {}),
    ...(typeof statusCode === "number" ? { statusCode } : {}),
    ...(typeof refusalCategory === "string" ? { refusalCategory } : {}),
  }));
  process.exitCode = 1;
});
