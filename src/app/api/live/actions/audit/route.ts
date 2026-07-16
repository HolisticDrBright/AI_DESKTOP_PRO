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
    return actionsLive.listAuditEvents(undefined, limit, session.token);
  });
}

/** POST { action, ... } -> append one PHI-safe audit event. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      resourceType?: unknown;
      resourceId?: unknown;
      safeMessage?: unknown;
      patientId?: unknown;
      metadata?: unknown;
    };
    if (typeof body.action !== "string" || !body.action) {
      throw new AdapterError("invalid", "An audit action is required.");
    }
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const session = await getRequestSession();
    return actionsLive.recordAudit({
      action: body.action,
      resourceType: str(body.resourceType),
      resourceId: str(body.resourceId),
      safeMessage: str(body.safeMessage),
      patientId: str(body.patientId),
      metadata:
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, unknown>)
          : {},
    }, session.token);
  });
}
