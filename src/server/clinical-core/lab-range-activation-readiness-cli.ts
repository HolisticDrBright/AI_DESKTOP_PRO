import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessLabRangeActivation } from "./lab-range-activation-readiness";

// prepared unsigned release file, evidence JSON file, exclusive-create report
// output. Reports only; never pins, signs or deploys a release.
try {
  const [preparedFile, evidenceFile, outputFile, ...extra] = process.argv.slice(2);
  if (!preparedFile || !evidenceFile || !outputFile || extra.length) throw new Error("invalid_arguments");
  const evidence = JSON.parse(readFileSync(resolve(evidenceFile), "utf8")) as Record<string, unknown>;
  if (typeof evidence.publicKeyPemFile === "string") {
    evidence.publicKeyPem = readFileSync(resolve(evidence.publicKeyPemFile), "utf8");
    delete evidence.publicKeyPemFile;
  }
  const report = assessLabRangeActivation(JSON.parse(readFileSync(resolve(preparedFile), "utf8")), evidence);
  writeFileSync(resolve(outputFile), JSON.stringify({ ...report, assessedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: report.status, blockers: report.blockers.length, ranges: report.ranges, payloadSha256: report.payloadSha256 }));
  if (report.status !== "ready_for_authorized_operator") process.exitCode = 2;
} catch {
  // Do not leak paths, keys or candidate contents on failure.
  console.error("activation_readiness_failed");
  process.exitCode = 1;
}
