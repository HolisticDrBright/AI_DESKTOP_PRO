import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runClinicalSafetyRegression } from "./clinical-safety-regression";

// prepared unsigned release file, regression inputs JSON (exclusions, optional
// catalogFile / knowledgeReleaseFile), exclusive-create report output.
// Reports only; never approves, pins, signs or deploys anything.
try {
  const [preparedFile, inputsFile, outputFile, ...extra] = process.argv.slice(2);
  if (!preparedFile || !inputsFile || !outputFile || extra.length) throw new Error("invalid_arguments");
  const inputs = JSON.parse(readFileSync(resolve(inputsFile), "utf8")) as Record<string, unknown>;
  for (const [file, key] of [["catalogFile", "catalog"], ["knowledgeReleaseFile", "knowledgeRelease"]] as const) {
    if (typeof inputs[file] === "string") { inputs[key] = JSON.parse(readFileSync(resolve(inputs[file] as string), "utf8")); delete inputs[file]; }
  }
  const report = runClinicalSafetyRegression(JSON.parse(readFileSync(resolve(preparedFile), "utf8")), inputs);
  writeFileSync(resolve(outputFile), JSON.stringify({ ...report, runAt: new Date().toISOString() }, null, 2), { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: report.status, failing: report.checks.filter(c => c.status === "fail").map(c => c.id),
    notApplicable: report.checks.filter(c => c.status === "not_applicable").map(c => c.id), payloadSha256: report.payloadSha256, evidenceSha256: report.evidenceSha256 }));
  if (report.status !== "pass") process.exitCode = 2;
} catch {
  // Do not leak paths, candidate contents or catalog data on failure.
  console.error("clinical_safety_regression_failed");
  process.exitCode = 1;
}
