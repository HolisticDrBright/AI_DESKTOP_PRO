import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** A request-local fence, never a process-global current owner. Provider calls
 * mark their dispatch before I/O; an unknown dispatch is not a retry permit. */
export type AppointmentOperation = {
  operationId: string;
  inputSha256: string;
  key: { pk: string; sk: string };
  requestKey: { pk: string; sk: string };
  expectedVersion: number;
  pool: "consumer" | "workforce";
  actorPersonId: string;
  actorSubject: string;
  admittedAt: string;
  /** Private per-invocation authority, never a client retry token. Closure
   * proves only this writer stopped; provider disposition is separate. */
  writerToken: string;
  effectsAttempted: boolean;
  effectsRecorded: boolean;
  committed: boolean;
  visitKey: { pk: string; sk: string } | null;
};

export const appointmentOperationScope = new AsyncLocalStorage<AppointmentOperation>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Legacy callers get an actor/version/input-bound identity. New clients must
 * persist an explicit UUID and this exact protocol before dispatch. */
export function appointmentOperationIdentity(pool: string, personId: string, subject: string, kind: string, input: Record<string, unknown>) {
  const { operationId: supplied, operationProtocol: protocol, ...payload } = input;
  const inputSha256 = createHash("sha256").update(canonical({ pool, personId, subject, kind, payload })).digest("hex");
  const operationId = typeof supplied === "string" ? supplied.toLowerCase()
    : `${inputSha256.slice(0, 8)}-${inputSha256.slice(8, 12)}-5${inputSha256.slice(13, 16)}-a${inputSha256.slice(17, 20)}-${inputSha256.slice(20, 32)}`;
  return { operationId, inputSha256, protocol };
}

export function operationReceipt(operation: AppointmentOperation, committedVersion: number, committedAt: string) {
  return { protocol: "appointment-change/1", operationId: operation.operationId,
    admittedVersion: operation.expectedVersion, committedVersion, committedAt };
}
