import { NextRequest } from "next/server";
import { actionsLive } from "@/adapters/actions.live";
import { AdapterError } from "@/adapters/errors";
import { liveGuard, runLive } from "../../route-helpers";

const PRIORITIES = ["low", "medium", "high"] as const;
type Priority = (typeof PRIORITIES)[number];

/** POST { patientId, title, itemType?, priority?, refId? } -> create a review task + audit. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      patientId?: unknown;
      title?: unknown;
      itemType?: unknown;
      priority?: unknown;
      refId?: unknown;
    };
    if (typeof body.patientId !== "string" || !body.patientId) {
      throw new AdapterError("invalid", "A patient id is required.");
    }
    if (typeof body.title !== "string" || !body.title.trim()) {
      throw new AdapterError("invalid", "A task title is required.");
    }
    const priority: Priority = PRIORITIES.includes(body.priority as Priority)
      ? (body.priority as Priority)
      : "medium";
    return actionsLive.createReviewTask({
      patientId: body.patientId,
      title: body.title.trim(),
      itemType: typeof body.itemType === "string" ? body.itemType : undefined,
      priority,
      refId: typeof body.refId === "string" ? body.refId : undefined,
    });
  });
}
