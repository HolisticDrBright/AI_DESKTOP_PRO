import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import type { LiveProgramEnrollmentStatus } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const STATUSES: LiveProgramEnrollmentStatus[] = [
  "invited", "active", "paused", "completed", "cancelled", "expired",
];

/**
 * POST { action: "enroll" | "status", ... }. Enrollment eligibility, version
 * pinning, comp authorization, and the state machine are all server-enforced.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      programId?: unknown;
      patientId?: unknown;
      offerId?: unknown;
      activate?: unknown;
      compReason?: unknown;
      enrollmentId?: unknown;
      status?: unknown;
      reason?: unknown;
    };
    const session = await getRequestSession();
    if (b.action === "enroll") {
      if (typeof b.programId !== "string" || typeof b.patientId !== "string") {
        throw new Error("programId and patientId are required");
      }
      return programsLive.enrollPatient(
        {
          programId: b.programId,
          patientId: b.patientId,
          offerId: typeof b.offerId === "string" ? b.offerId : null,
          activate: b.activate !== false,
          compReason: typeof b.compReason === "string" ? b.compReason : null,
        },
        session.token,
      );
    }
    if (b.action === "status") {
      if (typeof b.enrollmentId !== "string" || !b.enrollmentId) {
        throw new Error("enrollmentId is required");
      }
      if (!STATUSES.includes(b.status as LiveProgramEnrollmentStatus)) {
        throw new Error("unknown enrollment status");
      }
      return programsLive.setEnrollmentStatus(
        b.enrollmentId,
        b.status as LiveProgramEnrollmentStatus,
        typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : null,
        session.token,
      );
    }
    throw new Error("unknown enrollment action");
  });
}
