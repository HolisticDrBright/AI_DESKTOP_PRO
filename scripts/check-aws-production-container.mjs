import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "Dockerfile.production");
const source = readFileSync(path, "utf8");
const errors = [];

function requireMatch(pattern, message) {
  if (!pattern.test(source)) errors.push(message);
}

function forbid(pattern, message) {
  if (pattern.test(source)) errors.push(message);
}

requireMatch(/^FROM gcr\.io\/distroless\/nodejs22-debian12:nonroot AS runtime$/m,
  "runtime must use the non-root distroless Node 22 image");
requireMatch(/^\s*APP_EDITION=clinical\s*\\?$/m, "clinical edition must be fixed at image build time");
requireMatch(/^\s*NEXT_PUBLIC_APP_ENV=production\s*\\?$/m, "client posture must be production");
requireMatch(/^CMD \["server-entry\.mjs"\]$/m, "bounded server entry point is required");
requireMatch(/^RUN npm ci$/m, "dependency installation must use the lock file");

forbid(/SUPABASE|supabase/i, "production image definition must not name Supabase");
forbid(/FLY_APP|fly\.io|fly\.dev/i, "production image definition must not name Fly");
forbid(/APP.?RUNNER|awsapprunner/i, "production image definition must not name App Runner");
forbid(/(?:SECRET|PASSWORD|ANON_KEY|SERVICE_ROLE|API_KEY)\s*(?:=|$)/im,
  "production image definition must not accept or bake credentials");
forbid(/synthetic|staging/i, "production image definition must not contain synthetic/staging defaults");
forbid(/^USER\s+(?:root|0)\b/im, "production runtime must not run as root");

if (errors.length) {
  for (const error of errors) console.error(`AWS production container check failed: ${error}`);
  process.exitCode = 1;
} else {
  console.log("AWS production container check passed: production-only, credential-free, non-root distroless image definition.");
}
