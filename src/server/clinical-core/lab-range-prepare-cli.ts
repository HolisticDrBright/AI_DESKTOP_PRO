import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { preparePreciseLabRangeRelease } from "./prepare-lab-range-release";

// source directory, allowed JSON filename, numeric mapping file, exact manifest
// SHA-256 (canonical LF), output file, then a required typed policy file for
// pediatric sources. Output is exclusive-create and unsigned.
try {
  const [directory, sourceFile, candidateFile, manifestSha, outputFile, pediatricPolicyFile, ...extra] = process.argv.slice(2);
  if (!directory || !sourceFile || !candidateFile || !manifestSha || !outputFile || extra.length
    || !["hormone_population_ranges.json", "conventional_intervals.json", "functional_statements.json", "optimal_ranges.json"].includes(sourceFile))
    throw new Error("invalid_arguments");
  const folder = resolve(directory);
  const prepared = preparePreciseLabRangeRelease({
    manifestText: readFileSync(resolve(folder, "manifest.json"), "utf8"), expectedManifestSha256: manifestSha,
    sourceFile, sourceText: readFileSync(resolve(folder, sourceFile), "utf8"),
    ...(sourceFile === "hormone_population_ranges.json" ? { parentSourceText: readFileSync(resolve(folder, "optimal_ranges.json"), "utf8") } : {}),
    ...(["conventional_intervals.json", "functional_statements.json"].includes(sourceFile) ? {
      parentSourceText: readFileSync(resolve(folder, "pediatric_optimal_ranges.json"), "utf8"),
      packageReviewText: readFileSync(resolve(folder, "package_review.json"), "utf8"),
      pediatricPolicy: pediatricPolicyFile ? JSON.parse(readFileSync(resolve(pediatricPolicyFile), "utf8")) : undefined,
    } : {}),
    candidate: JSON.parse(readFileSync(resolve(candidateFile), "utf8")),
  });
  const payload = JSON.stringify(prepared.release);
  writeFileSync(resolve(outputFile), payload, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: prepared.status, ranges: prepared.release.ranges.length,
    payloadSha256: createHash("sha256").update(payload).digest("hex"), sourceFileSha256: prepared.sourceFileSha256 }));
} catch {
  // Do not leak source paths, clinical snippets or candidate contents on failure.
  console.error("range_release_preparation_failed");
  process.exitCode = 1;
}
