import { NextRequest, NextResponse } from "next/server";
import { getSyntheticClinicalCorePosture } from "@/server/clinical-core/synthetic-api-client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  try {
    const posture = await getSyntheticClinicalCorePosture("workforce", authorization);
    return NextResponse.json({ ok: true, posture }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      { ok: false, error: "synthetic_clinical_core_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
