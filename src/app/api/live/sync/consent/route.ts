import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import type { LiveSyncScope } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { connectionId, scope, grant, artifactTitle?, artifactVersion?, ... }. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      connectionId?: unknown;
      scope?: unknown;
      grant?: unknown;
      artifactTitle?: unknown;
      artifactVersion?: unknown;
      jurisdiction?: unknown;
      method?: unknown;
      authority?: unknown;
    };
    if (typeof b.connectionId !== "string" || typeof b.scope !== "string" || typeof b.grant !== "boolean") {
      throw new Error("connectionId, scope, and grant are required");
    }
    const session = await getRequestSession();
    return patientSyncLive.setConsentScope(
      {
        connectionId: b.connectionId,
        scope: b.scope as LiveSyncScope,
        grant: b.grant,
        artifactTitle: typeof b.artifactTitle === "string" ? b.artifactTitle : null,
        artifactVersion: typeof b.artifactVersion === "string" ? b.artifactVersion : null,
        jurisdiction: typeof b.jurisdiction === "string" ? b.jurisdiction : null,
        method: typeof b.method === "string" ? b.method : undefined,
        authority: typeof b.authority === "string" ? b.authority : undefined,
      },
      session.token,
    );
  });
}
