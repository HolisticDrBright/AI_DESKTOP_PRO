import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { conflictId, resolution, note, expectedVersion }. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      conflictId?: unknown;
      resolution?: unknown;
      note?: unknown;
      expectedVersion?: unknown;
    };
    const resolutions = [
      "resolved_keep_desktop",
      "resolved_keep_external",
      "resolved_manual",
      "dismissed",
    ] as const;
    if (
      typeof b.conflictId !== "string" ||
      typeof b.note !== "string" ||
      typeof b.expectedVersion !== "number" ||
      !resolutions.includes(b.resolution as (typeof resolutions)[number])
    ) {
      throw new Error("conflictId, resolution, note, and expectedVersion are required");
    }
    const session = await getRequestSession();
    return patientSyncLive.resolveConflict(
      {
        conflictId: b.conflictId,
        resolution: b.resolution as (typeof resolutions)[number],
        note: b.note,
        expectedVersion: b.expectedVersion,
      },
      session.token,
    );
  });
}
