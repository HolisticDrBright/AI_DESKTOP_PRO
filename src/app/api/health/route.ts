import { NextResponse } from "next/server";

/**
 * Minimal liveness for the WEB application only. Deliberately exposes
 * nothing else: no provider secrets, queue contents, patient data, worker
 * internals, or database details — and it does not depend on the sync
 * worker, so worker absence never makes the web application unhealthy.
 */
export function GET() {
  return NextResponse.json({ ok: true });
}
