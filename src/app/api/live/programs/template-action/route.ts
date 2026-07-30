import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { action: create|approve|archive|restore, ... } for program templates. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      name?: unknown;
      description?: unknown;
      fromVersionId?: unknown;
      versionId?: unknown;
      templateId?: unknown;
    };
    const session = await getRequestSession();
    switch (b.action) {
      case "create": {
        if (typeof b.name !== "string" || !b.name.trim()) {
          throw new Error("a template name is required");
        }
        return programsLive.createTemplate(
          {
            name: b.name.trim(),
            description: typeof b.description === "string" ? b.description : null,
            fromVersionId: typeof b.fromVersionId === "string" ? b.fromVersionId : null,
          },
          session.orgId,
          session.token,
        );
      }
      case "approve": {
        if (typeof b.versionId !== "string" || !b.versionId) {
          throw new Error("versionId is required");
        }
        return programsLive.approveTemplateVersion(b.versionId, session.token);
      }
      case "archive":
      case "restore": {
        if (typeof b.templateId !== "string" || !b.templateId) {
          throw new Error("templateId is required");
        }
        return programsLive.archiveTemplate(b.templateId, b.action === "archive", session.token);
      }
      default:
        throw new Error("unknown template action");
    }
  });
}
