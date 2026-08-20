if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-desktop-compatibility is server-only.");
}

import operationManifest from "../../../infra/aws-clinical-core/desktop-compatibility-operations.json";
import type { SyntheticRequestContext } from "./aws-identity-consent";
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from "./database";

export type DesktopCompatibilityRequest =
  | { kind: "rpc"; functionName: string; args: Record<string, unknown> }
  | { kind: "select"; table: string; query: string };

export type DesktopCompatibilityAdapter = {
  execute(context: SyntheticRequestContext, request: DesktopCompatibilityRequest): Promise<unknown>;
};

export class DesktopCompatibilityError extends Error {
  constructor(readonly category: "operation_refused" | "database_unavailable") {
    super(category);
    this.name = "DesktopCompatibilityError";
  }
}

const RPC_OPERATIONS = new Set(operationManifest.operations.rpc);
const READ_MODELS = new Set(operationManifest.operations.select);
const OPERATION = /^[a-z][a-z0-9_]{1,127}$/;
const ARGUMENT = /^_[a-z][a-z0-9_]{0,126}$/;

export function validateDesktopCompatibilityRequest(
  context: SyntheticRequestContext,
  value: unknown,
): DesktopCompatibilityRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refused();
  const input = value as Record<string, unknown>;
  if (input.kind === "rpc") {
    exactKeys(input, ["kind", "functionName", "args"]);
    if (typeof input.functionName !== "string" || !OPERATION.test(input.functionName)
      || !RPC_OPERATIONS.has(input.functionName)) throw refused();
    if (!isPlainObject(input.args)) throw refused();
    const args = input.args as Record<string, unknown>;
    if (Object.keys(args).length > 64 || Object.keys(args).some((key) => !ARGUMENT.test(key))) throw refused();
    assertJsonValue(args, 0);
    if ("_organization_id" in args && args._organization_id !== context.organizationId) throw refused();
    return { kind: "rpc", functionName: input.functionName, args };
  }
  if (input.kind === "select") {
    exactKeys(input, ["kind", "table", "query"]);
    if (typeof input.table !== "string" || !OPERATION.test(input.table) || !READ_MODELS.has(input.table)
      || typeof input.query !== "string" || input.query.length < 1 || input.query.length > 4096) throw refused();
    const params = new URLSearchParams(input.query);
    if ([...params].length > 16 || [...params.keys()].some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key))) throw refused();
    if (params.get("organization_id") !== `eq.${context.organizationId}`) throw refused();
    for (const [, valuePart] of params) {
      if (valuePart.length > 2048 || /[;\u0000-\u001f]/.test(valuePart)) throw refused();
    }
    return { kind: "select", table: input.table, query: input.query };
  }
  throw refused();
}

export function createAwsDesktopCompatibilityAdapter(database: ClinicalCoreDatabase): DesktopCompatibilityAdapter {
  return {
    async execute(context, request) {
      try {
        return await database.transaction(async (tx) => {
          await tx.query(`select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)`, [
            clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool,
            context.identitySubject, "clinical_data", context.environment, context.dataClassification,
          ]);
          const result = await tx.query<{ data: unknown }>(
            `select clinical_core.invoke_desktop_compatibility($1,$2::jsonb) as data`,
            [request.kind, JSON.stringify(request)],
          );
          if (result.rows.length !== 1) throw new DesktopCompatibilityError("operation_refused");
          return decodeJson(result.rows[0]?.data);
        });
      } catch (error) {
        if (error instanceof DesktopCompatibilityError) throw error;
        if (error instanceof ClinicalCoreDatabaseRejection) {
          throw new DesktopCompatibilityError("operation_refused");
        }
        throw new DesktopCompatibilityError("database_unavailable");
      }
    },
  };
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw refused();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, depth: number): void {
  if (depth > 8) throw refused();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw refused();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw refused();
    value.forEach((item) => assertJsonValue(item, depth + 1));
    return;
  }
  if (!isPlainObject(value) || Object.keys(value).length > 100) throw refused();
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key) || key.length > 128) throw refused();
    assertJsonValue(item, depth + 1);
  }
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new DesktopCompatibilityError("operation_refused"); }
}

function refused(): DesktopCompatibilityError {
  return new DesktopCompatibilityError("operation_refused");
}
