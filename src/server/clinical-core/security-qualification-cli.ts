import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runSecurityQualification } from "./security-qualification";

// Writes the credential-free security qualification report exclusively.
const output = resolve(process.argv[2] ?? "dist/qualification/security-qualification.json");
runSecurityQualification().then(report => {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ passed: report.passed, total: report.total, failed: report.failed, evidenceSha256: report.evidenceSha256 }));
  if (!report.passed) process.exitCode = 2;
}).catch(() => { console.error("security_qualification_failed"); process.exitCode = 1; });
