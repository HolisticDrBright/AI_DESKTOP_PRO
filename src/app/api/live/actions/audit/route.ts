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
 * display text are server-owned (backend audit registry) — this route never
 * forwards free-form messages.
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
    if (typeof body.eventType !== "string" || !body.eventType) {
      throw new AdapterError("invalid", "An audit event type is required.");
    }
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const metadata: Record<string, string | number | boolean> = {};
    if (body.metadata && typeof body.metadata === "object") {
      for (const [k, v] of Object.entries(body.metadata as Record<string, unknown>)) {
        if (["string", "number", "boolean"].includes(typeof v)) {
          metadata[k] = v as string | number | boolean;
        }
      }
    }
    const session = await getRequestSession();
    return actionsLive.recordAudit({
      eventType: body.eventType,
      resourceId: str(body.resourceId),
      patientId: str(body.patientId),
      metadata,
      organizationId: session.orgId ?? undefined,
    }, session.token);
  });
}
