import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { action: create | approve | archive, ... } — org template actions. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();

    switch (b.action) {
      case "create": {
        if (typeof b.name !== "string" || !b.name.trim()) {
          throw new AdapterError("invalid", "A template name is required.");
        }
        return protocolsLive.createTemplate(
          {
            name: b.name,
            description: typeof b.description === "string" ? b.description : null,
            fromVersionId: typeof b.fromVersionId === "string" ? b.fromVersionId : null,
          },
          session.orgId,
          session.token,
        );
      }
      case "approve": {
        if (typeof b.versionId !== "string") {
          throw new AdapterError("invalid", "A version id is required.");
        }
        return protocolsLive.approveTemplateVersion(b.versionId, session.token);
      }
      case "archive": {
        if (typeof b.templateId !== "string") {
          throw new AdapterError("invalid", "A template id is required.");
        }
        return protocolsLive.archiveTemplate(
          b.templateId,
          b.archived !== false,
          session.token,
        );
      }
      default:
        throw new AdapterError("invalid", "Unknown template action.");
    }
  });
}
