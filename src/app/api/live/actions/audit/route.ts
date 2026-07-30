import { NextRequest } from "next/server";
import { actionsLive } from "@/adapters/actions.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET ?limit= -> the caller's audit events (own events, or all if org admin). */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const raw = req.nextUrl.searchParams.get("limit");
    const limit = raw ? Math.min(Math.max(Number(raw) || 50, 1), 200) : 50;
    const session = await getRequestSession();
    return actionsLive.listAuditEvents(session.orgId ?? undefined, limit, session.token);
  });
}

/**
 * POST { eventType, patientId?, resourceId?, metadata? } -> append one
 * registry-validated audit event. The event's action, resource type, and
 * display text are database-owned; this route never accepts free-form audit
 * wording.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      eventType?: unknown;
      resourceId?: unknown;
      patientId?: unknown;
      metadata?: unknown;
    };
    const eventType = typeof body.eventType === "string"
      ? body.eventType.trim()
      : "";
    if (!eventType || eventType.length > 64) {
      throw new AdapterError("invalid", "An audit event type is required.");
    }

    const optionalId = (value: unknown, label: string) => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string") {
        throw new AdapterError("invalid", `${label} must be text.`);
      }
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 128) {
        throw new AdapterError("invalid", `${label} is invalid.`);
      }
      return trimmed;
    };

    const metadata: Record<string, string | number | boolean> = {};
    if (body.metadata !== undefined) {
      if (
        body.metadata === null
        || typeof body.metadata !== "object"
        || Array.isArray(body.metadata)
      ) {
        throw new AdapterError("invalid", "Audit metadata must be an object.");
      }
      const entries = Object.entries(body.metadata as Record<string, unknown>);
      if (entries.length > 16) {
        throw new AdapterError("invalid", "Audit metadata has too many fields.");
      }
      for (const [key, value] of entries) {
        const scalar = typeof value === "string"
          || typeof value === "boolean"
          || (typeof value === "number" && Number.isFinite(value));
        if (!scalar) {
          throw new AdapterError("invalid", "Audit metadata values must be simple fields.");
        }
        metadata[key] = value as string | number | boolean;
      }
    }
    const session = await getRequestSession();
    return actionsLive.recordAudit({
      eventType,
      resourceId: optionalId(body.resourceId, "Resource id"),
      patientId: optionalId(body.patientId, "Patient id"),
      metadata,
      organizationId: session.orgId ?? undefined,
    }, session.token);
  });
}
