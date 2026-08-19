import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const defaultAppRoot = resolve(desktopRoot, "../AI_LONGEVITY_PRO_V2-AWS-FOUNDATION/expo");
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ignoredDirectories = new Set([".git", ".next", "coverage", "dist", "node_modules"]);

const rules = [
  {
    id: "supabase_saas_runtime",
    pattern: /(?:@supabase\/|createClient\s*\(|SUPABASE_(?:URL|ANON_KEY|SERVICE_ROLE_KEY)|CLINICAL_SUPABASE_|SYNC_(?:WORKER_)?SUPABASE_)/i,
  },
  { id: "fly_runtime", pattern: /(?:\.fly\.dev\b|fly\.io\b|FLY_APP_NAME|FLY_REGION)/i },
  { id: "app_runner_runtime", pattern: /(?:awsapprunner\.com\b|AWS::AppRunner::Service)/i },
];

// These modules mention legacy provider names only to detect, refuse, or
// describe them. They do not construct a client or send runtime traffic.
// Keep this allowlist exact and rule-scoped so new files and new dependency
// types still fail the production gate.
const guardReferenceAllowlist = new Map([
  ["desktop:src/app/api/knowledge/authoring-pack/route.ts", new Set(["fly_runtime"])],
  ["desktop:src/server/runtime/awsProductionGate.ts", new Set(["supabase_saas_runtime", "fly_runtime"])],
  ["desktop:src/server/runtime/contractFixture.ts", new Set(["supabase_saas_runtime"])],
  ["desktop:src/server/runtime/deployedRuntime.ts", new Set(["fly_runtime"])],
  ["desktop:src/server/runtime/posture.ts", new Set(["supabase_saas_runtime"])],
  ["desktop:src/adapters/session.server.ts", new Set(["supabase_saas_runtime"])],
  ["desktop:src/lib/edition.server.ts", new Set(["supabase_saas_runtime"])],
  ["app:backend/clinical-core/aws-production-gate.ts", new Set(["supabase_saas_runtime", "fly_runtime"])],
]);

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...walk(resolve(directory, entry.name)));
    } else if (sourceExtensions.has(extname(entry.name)) && !/\.(?:test|spec)\.[^.]+$/i.test(entry.name)) {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}

function projectFiles(root, sourceDirectories) {
  return sourceDirectories.flatMap((directory) => walk(resolve(root, directory)));
}

export function scanAwsDataPlaneMigration({ desktop = desktopRoot, app = defaultAppRoot } = {}) {
  const projects = [
    { name: "desktop", root: desktop, directories: ["src"] },
    { name: "app", root: app, directories: ["app", "backend", "lib"] },
  ];
  const findings = [];
  const guardReferences = [];
  for (const project of projects) {
    for (const path of projectFiles(project.root, project.directories)) {
      const content = readFileSync(path, "utf8");
      const file = relative(project.root, path).replaceAll("\\", "/");
      for (const rule of rules) {
        if (rule.pattern.test(content)) {
          const finding = { project: project.name, rule: rule.id, file };
          const allowedRules = guardReferenceAllowlist.get(`${project.name}:${file}`);
          if (allowedRules?.has(rule.id)) guardReferences.push(finding);
          else findings.push(finding);
        }
      }
    }
  }
  return {
    ready: findings.length === 0,
    phi_allowed: false,
    scanned_projects: projects.map(({ name, root }) => ({ name, root, present: existsSync(root) })),
    blockers: findings,
    guard_references: guardReferences,
    counts: Object.fromEntries(rules.map((rule) => [rule.id, findings.filter((item) => item.rule === rule.id).length])),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes("--enforce") ? "enforce" : "report";
  const appArgument = process.argv.find((argument) => argument.startsWith("--app-root="));
  const report = scanAwsDataPlaneMigration({ app: appArgument ? resolve(appArgument.slice(11)) : defaultAppRoot });
  console.log(JSON.stringify(report, null, 2));
  if (mode === "enforce" && !report.ready) {
    console.error(`AWS production data-plane activation refused: ${report.blockers.length} runtime dependency blockers remain.`);
    process.exitCode = 1;
  }
}
