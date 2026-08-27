import { NextResponse } from "next/server";
import { describeRuntimePosture } from "@/server/runtime/posture";

/**
 * GET /api/live/posture — a PHI-safe runtime-posture probe.
 *
 * Reports which approved AWS API Gateway endpoint the running server would
 * call, whether live mode is on, and whether the response would come from AWS
 * or a local fixture. Never returns a key, JWT, cookie, package content, or
 * practitioner identity. Every field is a short bounded label.
 */
export function GET() {
  return NextResponse.json({ ok: true, posture: describeRuntimePosture() });
}
