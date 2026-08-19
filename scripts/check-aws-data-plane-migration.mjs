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
  for (const project of projects) {
    for (const path of projectFiles(project.root, project.directories)) {
      const content = readFileSync(path, "utf8");
      for (const rule of rules) {
        if (rule.pattern.test(content)) {
          findings.push({ project: project.name, rule: rule.id, file: relative(project.root, path).replaceAll("\\", "/") });
        }
      }
    }
  }
  return {
    ready: findings.length === 0,
    phi_allowed: false,
    scanned_projects: projects.map(({ name, root }) => ({ name, root, present: existsSync(root) })),
    blockers: findings,
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
