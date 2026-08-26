import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const template = JSON.parse(readFileSync(`${root}infra/aws-clinical-core/desktop-web-hosting.json`, "utf8"));
const dockerfile = readFileSync(`${root}Dockerfile`, "utf8");
const serialized = JSON.stringify(template);
const errors = [];
const need = (condition, message) => { if (!condition) errors.push(message); };

need(!/supabase/i.test(serialized), "synthetic Desktop hosting must not inject Supabase configuration");
need(!/supabase/i.test(dockerfile), "the hosted Desktop image must not require Supabase configuration");
for (const required of [
  "CLINICAL_DATA_PLANE", "CLINICAL_AWS_API_ORIGIN", "CLINICAL_AWS_WORKFORCE_API_ORIGIN",
  "CLINICAL_AWS_WORKFORCE_USER_POOL_ID", "CLINICAL_AWS_WORKFORCE_CLIENT_ID",
  "AWS_CLINICAL_ADAPTER_READY", "PHI_ALLOWED",
]) need(serialized.includes(required), `hosting template is missing ${required}`);
need(serialized.includes('"Value":"aws"'), "synthetic Desktop must select the AWS data plane");
need(serialized.includes('"Name":"CLINICAL_AWS_RUNTIME_MODE","Value":"synthetic"'), "runtime must remain synthetic");
need(serialized.includes('"Name":"PHI_ALLOWED","Value":"false"'), "PHI must remain disabled");
need(serialized.includes('"RealPatientDataAllowed","Value":"false"'), "service must retain the no-real-data tag");
need(dockerfile.includes("FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime"), "runtime must remain non-root distroless");

if (errors.length) {
  errors.forEach((error) => console.error(`AWS Desktop hosting check failed: ${error}`));
  process.exitCode = 1;
} else {
  console.log("AWS Desktop hosting check passed: AWS-only synthetic runtime, Cognito workforce boundary, PHI disabled.");
}
