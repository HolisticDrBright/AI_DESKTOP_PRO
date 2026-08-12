if (typeof window !== "undefined") {
  throw new Error("clinical-core/migrations is server-only.");
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ClinicalCoreDatabase } from "./database";

export type ClinicalCoreMigration = {
  version: string;
  name: string;
  sql: string;
  sha256: string;
};

type MigrationManifest = {
  contract_version: "clinical-core-migrations/1";
  migrations: Array<{ version: string; file: string }>;
};

const VERSION_PATTERN = /^\d{14}$/;
const FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

export class ClinicalCoreMigrationError extends Error {
  constructor(readonly category: "manifest_invalid" | "history_mismatch" | "migration_failed") {
    super(category);
    this.name = "ClinicalCoreMigrationError";
  }
}

export function loadClinicalCoreMigrations(
  directory = path.join(process.cwd(), "infra", "aws-clinical-core", "migrations"),
): ClinicalCoreMigration[] {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as MigrationManifest;
  if (manifest.contract_version !== "clinical-core-migrations/1" || !Array.isArray(manifest.migrations)) {
    throw new ClinicalCoreMigrationError("manifest_invalid");
  }

  let previous = "";
  const seen = new Set<string>();
  return manifest.migrations.map((entry) => {
    if (
      !VERSION_PATTERN.test(entry.version)
      || !FILE_PATTERN.test(entry.file)
      || !entry.file.startsWith(`${entry.version}_`)
      || entry.version <= previous
      || seen.has(entry.version)
    ) {
      throw new ClinicalCoreMigrationError("manifest_invalid");
    }
    previous = entry.version;
    seen.add(entry.version);
    const sql = readFileSync(path.join(directory, entry.file), "utf8");
    if (!sql.trim()) throw new ClinicalCoreMigrationError("manifest_invalid");
    return {
      version: entry.version,
      name: entry.file.slice(15, -4),
      sql,
      sha256: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

/** Split PostgreSQL source without breaking quoted text, comments, or dollar-quoted function bodies. */
export function splitPostgresStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let state: "normal" | "single" | "double" | "line_comment" | "block_comment" | "dollar" = "normal";
  let blockDepth = 0;
  let dollarTag = "";

  while (index < sql.length) {
    const current = sql[index]!;
    const next = sql[index + 1];

    if (state === "normal") {
      if (current === "'") {
        state = "single";
        index += 1;
        continue;
      }
      if (current === '"') {
        state = "double";
        index += 1;
        continue;
      }
      if (current === "-" && next === "-") {
        state = "line_comment";
        index += 2;
        continue;
      }
      if (current === "/" && next === "*") {
        state = "block_comment";
        blockDepth = 1;
        index += 2;
        continue;
      }
      if (current === "$") {
        const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
        if (tag) {
          state = "dollar";
          dollarTag = tag;
          index += tag.length;
          continue;
        }
      }
      if (current === ";") {
        const statement = sql.slice(start, index).trim();
        if (statement) statements.push(statement);
        start = index + 1;
      }
      index += 1;
      continue;
    }

    if (state === "single") {
      if (current === "\\" && next !== undefined) {
        index += 2;
      } else if (current === "'" && next === "'") {
        index += 2;
      } else if (current === "'") {
        state = "normal";
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (state === "double") {
      if (current === '"' && next === '"') {
        index += 2;
      } else if (current === '"') {
        state = "normal";
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (state === "line_comment") {
      if (current === "\n" || current === "\r") state = "normal";
      index += 1;
      continue;
    }

    if (state === "block_comment") {
      if (current === "/" && next === "*") {
        blockDepth += 1;
        index += 2;
      } else if (current === "*" && next === "/") {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) state = "normal";
      } else {
        index += 1;
      }
      continue;
    }

    if (state === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        state = "normal";
      } else {
        index += 1;
      }
    }
  }

  if (state !== "normal" && state !== "line_comment") {
    throw new ClinicalCoreMigrationError("manifest_invalid");
  }
  const remainder = sql.slice(start).trim();
  if (remainder) statements.push(remainder);
  return statements;
}

/** Apply ordered migrations atomically and refuse rewritten history. */
export async function applyClinicalCoreMigrations(
  database: ClinicalCoreDatabase,
  migrations = loadClinicalCoreMigrations(),
): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", ["ai-desktop-pro:clinical-core-migrations"]);
      await tx.query("create schema if not exists clinical_core");
      await tx.query(`create table if not exists clinical_core.schema_migrations (
        version text primary key,
        name text not null,
        sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default clock_timestamp()
      )`);

      const existing = await tx.query<{ version: string; sha256: string }>(
        "select version, sha256 from clinical_core.schema_migrations order by version",
      );
      const byVersion = new Map(existing.rows.map((row) => [row.version, row.sha256]));
      const applied: string[] = [];
      const alreadyApplied: string[] = [];

      for (const migration of migrations) {
        const recordedHash = byVersion.get(migration.version);
        if (recordedHash) {
          if (recordedHash !== migration.sha256) {
            throw new ClinicalCoreMigrationError("history_mismatch");
          }
          alreadyApplied.push(migration.version);
          continue;
        }
        const statements = splitPostgresStatements(migration.sql);
        if (statements.length === 0) throw new ClinicalCoreMigrationError("manifest_invalid");
        for (const statement of statements) await tx.query(statement);
        await tx.query(
          "insert into clinical_core.schema_migrations (version, name, sha256) values ($1, $2, $3)",
          [migration.version, migration.name, migration.sha256],
        );
        applied.push(migration.version);
      }
      return { applied, alreadyApplied };
    });
  } catch (error) {
    if (error instanceof ClinicalCoreMigrationError) throw error;
    throw new ClinicalCoreMigrationError("migration_failed");
  }
}
