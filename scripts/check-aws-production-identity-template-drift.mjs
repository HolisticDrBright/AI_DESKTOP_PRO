import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const IDENTITY_RESOURCES = [
  "WorkforceUserPool", "WorkforceUserPoolClient",
  "ConsumerUserPool", "ConsumerUserPoolClient",
];

/** Any difference requires a separately reviewed CloudFormation change set. */
export function identityResourceDifferences(deployed, proposed) {
  return IDENTITY_RESOURCES.filter((name) =>
    !deployed?.Resources?.[name] || !proposed?.Resources?.[name]
      || deployed.Resources[name].Type !== proposed.Resources[name].Type
      || !isDeepStrictEqual(deployed?.Resources?.[name], proposed?.Resources?.[name]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const get = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const profile = get("--profile");
  const region = get("--region");
  const stack = get("--stack");
  const candidatePath = get("--candidate");
  if (!profile || !region || !stack || !candidatePath) {
    console.error("identity_template_check_arguments_missing");
    process.exitCode = 2;
  } else {
    try {
      const response = JSON.parse(execFileSync("aws", ["cloudformation", "get-template",
        "--profile", profile, "--region", region, "--stack-name", stack,
        "--output", "json"], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
      const deployed = typeof response.TemplateBody === "string"
        ? JSON.parse(response.TemplateBody) : response.TemplateBody;
      const proposed = JSON.parse(readFileSync(candidatePath, "utf8"));
      const changes = identityResourceDifferences(deployed, proposed);
      if (changes.length) {
        console.error(`identity_template_review_required:${changes.join(",")}`);
        process.exitCode = 1;
      } else {
        console.log("Identity resources match the deployed CloudFormation template.");
      }
    } catch {
      console.error("identity_template_observation_failed");
      process.exitCode = 1;
    }
  }
}
