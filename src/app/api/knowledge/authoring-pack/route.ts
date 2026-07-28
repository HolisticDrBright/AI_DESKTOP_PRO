import { NextResponse } from "next/server";
import { USE_LIVE_API } from "@/adapters/mode";
import { getRequestSession } from "@/server/session";
import authoringPack from "../../../../../data/clinical-knowledge/authoring-pack-core.json";

export const runtime = "nodejs";

function isDeployedEnvironment() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT_ID
      || process.env.RAILWAY_PROJECT_ID
      || process.env.FLY_APP_NAME
      || process.env.VERCEL,
  );
}

export async function GET() {
  if (!USE_LIVE_API && isDeployedEnvironment()) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Authoring pack unavailable." } },
      { status: 404 },
    );
  }

  if (USE_LIVE_API) {
    const session = await getRequestSession();
    if (!session.signedIn || !session.token || !session.orgId) {
      return NextResponse.json(
        { error: { code: "unauthorized", message: "An authenticated organization is required." } },
        { status: 401 },
      );
    }
  }

  return NextResponse.json(authoringPack, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
